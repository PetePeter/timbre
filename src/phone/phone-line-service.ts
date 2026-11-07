/**
 * PhoneLineService — the one object main wires in. Owns the telefony-app
 * process, the PhAP client and the PhoneBridge, and re-applies settings:
 * a change to anything written into telefony.toml restarts telefony, but
 * never under a live call (the restart waits for the line to go idle).
 *
 * It is the stable ChatBridge registered with the broker; the client and
 * bridge behind it are rebuilt when the port or token changes.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { ChatClient } from '../session/api/api-agent-loop.js';
import type { SmsConversationContext } from '../agents/phone-agent.js';
import type { ChatBridge, ChatOutboundMessage, ChatSendResult } from '../session/chat/chat-bridge.js';
import type { PhoneContact } from './phone-config.js';
import type { AddressBookContact } from '../contacts/contact.js';
import { ContactPinStore } from '../contacts/contact-pin-store.js';
import { PhapClient } from './phap-client.js';
import { AppCallNotFoundError, PhoneBridge, PHONE_PROVIDER, type AppCallAction, type CallAgentRequest, type ContactTransferResult, type LiveAudioEvent, type LiveCallEvent, type LiveCallStream, type PhoneBridgeStatus, type SmsMemory } from './phone-bridge.js';
import type { AppCallDesk } from './app-call-desk.js';
import type { AgentCallOutcome } from '../records/event-types.js';
import type { RecordEventWriter } from './phone-recording.js';
import type { PhoneLineConfig } from './phone-config.js';
import { TelefonyProcess, type TelefonyStatus } from './telefony-process.js';
import { PhoneLineTransport, VirtualCallLine, type TestCallStreamEvent } from './virtual-call-line.js';
import type { PhoneSmsActionRequest, SmsAutoReplyAuthorization } from './sms-auto-reply.js';
import type { SmsActionAuthorizationResult } from './sms-pin-auth.js';

export interface PhoneLineServiceDeps {
  /** Stable identity of this phone line, used to scope transcript exports. */
  phoneId: string;
  getConfig: () => PhoneLineConfig;
  saveConfig: (cfg: PhoneLineConfig) => void;
  /** Shared PhAP server executable configured for this Timbre installation. */
  getExecutable: () => string;
  /** Where Timbre writes telefony.toml. */
  telefonyConfigPath: string;
  /** Private per-phone WAV output directory shared with telefony. */
  recordingsDir: string;
  defaultTranscriptDir: string;
  getAppVersion: () => string;
  getOperatorId: () => string | null;
  sessionName: (sessionId: string) => string | undefined;
  deliver: (sessionId: string, text: string, context?: SmsConversationContext) => Promise<void>;
  log: (msg: string) => void;
  /** Per-phone append-only event writer. */
  recordEvent?: RecordEventWriter;
  /** Bounded recent event history for one normalized caller number. */
  readSpamHistory?: (number: string) => readonly unknown[];
  /** P-1101 address-book lookup, shared with the contacts API. */
  lookupAddressBook?: (number?: string) => AddressBookContact[];
  /** The shared policy-checked action path for all phone-originated SMS. */
  sendSmsAction?: (request: PhoneSmsActionRequest) => Promise<ChatSendResult>;
  /** The phone's own LLM as a chat client; null when it is not a valid API LLM. */
  callAgentModel?: () => ChatClient | null;
  /** How long the Bluetooth link may stay down, with telefony reconnecting, before Timbre restarts telefony. */
  linkDownRestartMs?: number;
  /** Test seam: the telefony process (real by default). */
  process?: TelefonyProcess;
  /** Inbound-call desk for apps with calls.receive; outlives line restarts. */
  appCalls?: AppCallDesk;
}

export interface PhoneLineStatus {
  enabled: boolean;
  process: TelefonyStatus;
  pendingRestart: boolean;
  line: PhoneBridgeStatus | null;
  configPath: string;
}

/** Default for PhoneLineServiceDeps.linkDownRestartMs: telefony's own recovery gets this long first. */
export const LINK_DOWN_RESTART_MS = 5 * 60_000;

/** The line's state in one sentence, for tool results and listings. */
export function describeLine(status: PhoneLineStatus | undefined): string {
  if (!status?.enabled) return 'Phone line is off.';
  if (!status.line) return 'Phone line is starting.';
  return status.line.problem ?? 'Ready: the phone is linked over Bluetooth.';
}

export class PhoneLineService extends EventEmitter implements ChatBridge {
  readonly provider = PHONE_PROVIDER;
  private readonly proc: TelefonyProcess;
  private client: PhapClient | null = null;
  private transport: PhoneLineTransport | null = null;
  private bridge: PhoneBridge | null = null;
  private testCall: VirtualCallLine | null = null;
  private testCallStreamClose: (() => void) | null = null;
  private testCallStatusListener: (() => void) | null = null;
  private liveAudioSession: { callId: string; stop: () => Promise<void> } | null = null;
  private appliedToml = '';
  private appliedExecutable = '';
  private appliedLink = '';
  private pendingRestart = false;
  private linkDownTimer: NodeJS.Timeout | null = null;
  private readonly smsMemory: SmsMemory = { seen: new Set(), received: new Set(), primed: false };
  private readonly contactPins: ContactPinStore;
  private applying: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PhoneLineServiceDeps) {
    super();
    this.contactPins = new ContactPinStore(path.dirname(deps.defaultTranscriptDir));
    this.proc = deps.process ?? new TelefonyProcess({
      configPath: deps.telefonyConfigPath,
      recordingsDir: deps.recordingsDir,
      log: deps.log,
    });
    this.proc.on('status', () => this.emitStatus());
  }

  /** Bring the line in line with settings. Safe to call on every save; calls run one at a time. */
  apply(): Promise<void> {
    this.applying = this.applying.then(() => this.applyNow(), () => this.applyNow());
    return this.applying;
  }

  private async applyNow(): Promise<void> {
    let cfg = this.deps.getConfig();
    if (!cfg.enabled) { await this.stopNow(); return; }
    if (!cfg.token) {
      cfg = { ...cfg, token: randomBytes(24).toString('base64url') };
      this.deps.saveConfig(cfg);
    }
    const executable = this.deps.getExecutable();
    const link = `${cfg.port}|${cfg.token}|${cfg.heartbeatS}`;
    const toml = await this.proc.renderConfig(cfg);
    const procState = this.proc.getStatus().state;
    const needsRestart = toml !== this.appliedToml || executable !== this.appliedExecutable || procState === 'stopped' || procState === 'failed';
    if ((link !== this.appliedLink || needsRestart) && (this.bridge?.getStatus().call || this.testCall)) {
      // Never under a live call: both the link and telefony wait for it to end.
      this.pendingRestart = true;
      this.emitStatus();
      return;
    }
    if (link !== this.appliedLink) this.rebuildLink(cfg, link);
    if (needsRestart) await this.restartProcess(cfg, toml, executable);
    this.emitStatus();
  }

  stop(): Promise<void> {
    this.applying = this.applying.then(() => this.stopNow(), () => this.stopNow());
    return this.applying;
  }

  private async stopNow(): Promise<void> {
    this.pendingRestart = false;
    this.clearLinkDownTimer();
    await this.liveAudioSession?.stop();
    await this.bridge?.hangupAll();
    this.testCall?.end('line_stopped');
    this.testCallStreamClose?.();
    this.testCallStreamClose = null;
    this.testCall = null;
    if (this.testCallStatusListener) this.bridge?.off('status', this.testCallStatusListener);
    this.testCallStatusListener = null;
    this.bridge?.stop();
    this.transport?.dispose();
    this.client?.stop();
    this.bridge = null;
    this.transport = null;
    this.client = null;
    this.appliedLink = '';
    this.appliedToml = '';
    this.appliedExecutable = '';
    await this.proc.stop();
    this.emitStatus();
  }

  getStatus(): PhoneLineStatus {
    return {
      enabled: this.deps.getConfig().enabled,
      process: this.proc.getStatus(),
      pendingRestart: this.pendingRestart,
      line: this.bridge?.getStatus() ?? null,
      configPath: this.deps.telefonyConfigPath,
    };
  }

  /** Force a telefony restart (Settings button); refused under a live call. */
  async restart(): Promise<void> {
    if (this.bridge?.getStatus().call || this.testCall) throw new Error('A call is live — hang up first.');
    const cfg = this.deps.getConfig();
    if (cfg.enabled) await this.restartProcess(cfg, await this.proc.renderConfig(cfg), this.deps.getExecutable());
  }

  // ---- delegated surface ---------------------------------------------------

  isAvailable(): boolean { return this.bridge?.isAvailable() ?? false; }

  sendToSession(message: ChatOutboundMessage): Promise<ChatSendResult> {
    return this.bridge?.sendToSession(message) ?? Promise.resolve({ sent: false, reason: 'phone line off' });
  }

  sendSms(contact: PhoneContact, text: string, interactionId?: string, clientName?: string): Promise<ChatSendResult> {
    return this.bridge?.sendSms(contact, text, interactionId, clientName)
      ?? Promise.resolve({ sent: false, reason: 'phone line off' });
  }

  hasContact(name: string, _sessionId?: string): boolean { return this.bridge?.hasContact(name) ?? false; }

  sendSmsToContact(sessionId: string, name: string, text: string, authorization?: SmsActionAuthorizationResult): Promise<ChatSendResult> {
    return this.bridge?.sendSmsToContact(sessionId, name, text, authorization)
      ?? Promise.resolve({ sent: false, reason: 'phone line off' });
  }

  /** Records only the tool name and outcome; tool arguments and phone text stay out of the activity log. */
  recordAgentToolCall(interactionId: string, toolName: string, outcome: 'started' | 'completed' | 'failed'): void {
    const type = outcome === 'started' ? 'agent.tool_started' : 'agent.tool_finished';
    try {
      this.deps.recordEvent?.({
        eventId: randomBytes(16).toString('hex'), interactionId, kind: 'system', type,
        occurredAt: new Date().toISOString(),
        details: { toolName: toolName.slice(0, 100), ...(outcome === 'started' ? {} : { outcome }) },
      });
    } catch (err) {
      try { this.deps.log(`phone tool activity write failed: ${(err as Error).message}`); } catch { /* logging must not affect a phone tool */ }
    }
  }

  openLiveCallStream(callId: string, listener: (event: LiveCallEvent) => void): LiveCallStream {
    if (!this.bridge) throw new Error('Live calls are unavailable for this phone.');
    return this.bridge.openLiveCallStream(callId, listener);
  }

  async openLiveAudioStream(callId: string, listener: (event: LiveAudioEvent) => void): Promise<() => void> {
    const bridge = this.bridge;
    const client = this.client;
    if (!bridge || !client?.isConnected()) throw new Error('Phone line is not connected.');
    if (this.liveAudioSession) throw new Error('Live audio is already in use.');
    const closeBridge = bridge.openLiveAudioStream(callId, listener);
    let started = false;
    let closed = false;
    let stopPromise: Promise<void> | undefined;
    let startRequest: Promise<unknown> = Promise.resolve();
    const session = {
      callId,
      stop: async (): Promise<void> => {
        closed = true;
        closeBridge();
        if (this.liveAudioSession === session) this.liveAudioSession = null;
        if (!stopPromise) {
          stopPromise = (async () => {
            await startRequest?.catch(() => undefined);
            if (started && client.isConnected()) {
              await client.request('call.audio.stop', { callId }).then(() => undefined).catch(() => undefined);
            }
          })();
        }
        await stopPromise;
      },
    };
    this.liveAudioSession = session;
    startRequest = client.request('call.audio.start', { callId }).then((result) => { started = true; return result; });
    try {
      await startRequest;
      if (closed) await session.stop();
      return () => { void session.stop(); };
    } catch (err) {
      await session.stop();
      throw err;
    }
  }

  appCallAction(callId: string, appId: string, action: AppCallAction, arg?: string): Promise<void> {
    if (!this.bridge) return Promise.reject(new AppCallNotFoundError());
    return this.bridge.appCallAction(callId, appId, action, arg);
  }

  takeoverLiveCall(callId: string): Promise<void> {
    if (!this.bridge) return Promise.reject(new Error('Live calls are unavailable for this phone.'));
    return this.bridge.takeoverLiveCall(callId);
  }

  sendSmsFromAction(contact: PhoneContact, text: string, interactionId: string | undefined, clientName: string | undefined, authorization: SmsAutoReplyAuthorization): Promise<ChatSendResult> {
    return this.bridge?.sendSms(contact, text, interactionId, clientName, authorization)
      ?? Promise.resolve({ sent: false, reason: 'phone line off' });
  }

  ringOwner(sessionId: string, reason: string): boolean {
    return this.deps.getConfig().fallback.ring && (this.bridge?.ringOwner(sessionId, reason) ?? false);
  }

  /** notify_user fallback (off by default — notifications are frequent). */
  notifyOwner(title: string, content: string): void {
    if (!this.deps.getConfig().fallback.notify || !this.bridge) return;
    void this.bridge.textOwner(`${title}: ${content}`).catch((err) => this.deps.log(`phone notify failed: ${(err as Error).message}`));
  }

  /** Settings test button. */
  testSms(): Promise<ChatSendResult> {
    return this.requireBridge().textOwner(`${this.deps.getConfig().persona.name}: phone line test.`);
  }

  /** Settings test button: ring the owner on behalf of the operator. */
  testRing(): boolean {
    const operator = this.deps.getOperatorId();
    return !!operator && !!this.bridge?.ringOwner(operator, 'This is a phone line test.');
  }
  isCallHolder(sessionId: string): boolean { return this.bridge?.isCallHolder(sessionId) ?? false; }
  transfer(from: string, to: string, line: string): Promise<boolean> { return this.bridge?.transfer(from, to, line) ?? Promise.resolve(false); }
  transferToContact(sessionId: string, name?: string): Promise<ContactTransferResult> {
    return this.requireBridge().transferToContact(sessionId, name);
  }
  enterMessageMode(sessionId: string): boolean { return this.bridge?.enterMessageMode(sessionId) ?? false; }
  reportCallOutcome(sessionId: string, interactionId: string, outcome: AgentCallOutcome): boolean {
    return this.bridge?.reportCallOutcome(sessionId, interactionId, outcome) ?? false;
  }
  verifyCaller(sessionId: string): Promise<string> { return this.requireBridge().verifyCaller(sessionId); }
  isCallerVerified(sessionId: string): boolean { return this.bridge?.isVerifiedCaller(sessionId) ?? false; }
  hangup(sessionId: string) { return this.requireBridge().hangup(sessionId); }
  hangupCurrentCall(callId: string) { return this.requireBridge().hangupCurrentCall(callId); }
  conferenceAdd(sessionId: string, label: string) { return this.requireBridge().conferenceAdd(sessionId, label); }
  inbox() { return this.requireBridge().inbox(); }
  startCallAgent(sessionId: string, req: CallAgentRequest, smsInteractionId?: string) {
    return this.requireBridge().startCallAgent(sessionId, req, smsInteractionId);
  }
  authorizeSmsAction(sessionId: string, interactionId: string, consumeMcpAction?: boolean) {
    return this.bridge?.authorizeSmsAction(sessionId, interactionId, consumeMcpAction)
      ?? { required: true, allowed: false, refusal: 'SMS action authorization is unavailable.' };
  }
  authorizeSmsReply(sessionId: string, sourceInteractionId: string, replyInteractionId: string, consumeMcpAction?: boolean) {
    return this.bridge?.authorizeSmsReply(sessionId, sourceInteractionId, replyInteractionId, consumeMcpAction)
      ?? { required: true, allowed: false, refusal: 'SMS reply authorization is unavailable.' };
  }
  refuseSmsAction(sessionId: string, interactionId: string, refusal?: string): Promise<void> {
    return this.bridge?.refuseSmsAction(sessionId, interactionId, refusal) ?? Promise.resolve();
  }
  startOwnerCallAgent(req: CallAgentRequest, requesterLabel: string, appId?: string) {
    return this.requireBridge().startOwnerCallAgent(req, requesterLabel, appId);
  }

  startTestCall(callerNumber: string): { callId: string } {
    const bridge = this.requireBridge();
    const transport = this.transport;
    if (!transport?.canStartTestCall() || bridge.getStatus().call || this.testCall) throw new Error('The phone line is busy.');
    const line = new VirtualCallLine({ callerNumber });
    transport.attachTestCall(line);
    this.testCall = line;
    line.on('ended', () => setImmediate(() => this.releaseTestCallIfDone(line)));
    const statusListener = () => this.releaseTestCallIfDone(line);
    this.testCallStatusListener = statusListener;
    bridge.on('status', statusListener);
    line.start();
    return { callId: line.callId };
  }

  openTestCallStream(callId: string, listener: (event: TestCallStreamEvent) => void): () => void {
    const line = this.requireTestCall(callId);
    const closeStream = line.openStream(listener);
    const close = () => {
      closeStream();
      if (!line.isEnded()) line.end('stream_closed');
      this.releaseTestCallIfDone(line);
    };
    this.testCallStreamClose = close;
    return close;
  }

  submitTestCallUtterance(callId: string, text: string): void {
    this.requireTestCall(callId).submitUtterance(text);
  }

  endTestCall(callId: string): void {
    this.requireTestCall(callId).end('browser_hangup');
  }

  // ---- internals -------------------------------------------------------------

  private requireBridge(): PhoneBridge {
    if (!this.bridge?.isAvailable()) throw new Error('The phone line is not connected (Settings > Phone line).');
    return this.bridge;
  }

  private requireTestCall(callId: string): VirtualCallLine {
    if (!this.testCall || this.testCall.callId !== callId) throw new Error('Test call not found.');
    return this.testCall;
  }

  private releaseTestCallIfDone(line: VirtualCallLine): void {
    if (this.testCall !== line || !line.isEnded() || line.hasStream() || this.bridge?.getStatus().call) return;
    this.transport?.detachTestCall(line.callId);
    if (this.testCallStatusListener) this.bridge?.off('status', this.testCallStatusListener);
    this.testCallStatusListener = null;
    this.testCall = null;
    this.testCallStreamClose = null;
    this.emitStatus();
    this.retryPendingRestartIfIdle();
  }

  private retryPendingRestartIfIdle(): void {
    if (!this.pendingRestart || this.bridge?.getStatus().call || this.testCall) return;
    void this.apply().catch((err) => {
      this.deps.log(`pending phone line restart failed: ${(err as Error).message || String(err)}`);
    });
  }

  private rebuildLink(cfg: PhoneLineConfig, link: string): void {
    this.bridge?.stop();
    this.transport?.dispose();
    this.client?.stop();
    const client = new PhapClient({
      uri: `ws://127.0.0.1:${cfg.port}/phap`, token: cfg.token, clientVersion: this.deps.getAppVersion(),
      heartbeatS: cfg.heartbeatS, log: this.deps.log,
    });
    const transport = new PhoneLineTransport(client);
    const bridge = new PhoneBridge({
      client: transport,
      phoneId: this.deps.phoneId,
      getConfig: this.deps.getConfig,
      getOperatorId: this.deps.getOperatorId,
      sessionName: this.deps.sessionName,
      deliver: this.deps.deliver,
      defaultTranscriptDir: this.deps.defaultTranscriptDir,
      recordingsDir: this.deps.recordingsDir,
      log: this.deps.log,
      recordEvent: this.deps.recordEvent,
      readSpamHistory: this.deps.readSpamHistory,
      lookupAddressBook: this.deps.lookupAddressBook,
      sendSmsAction: this.deps.sendSmsAction,
      hasCallerPin: (contactId) => this.contactPins.hasPin(contactId),
      verifyCallerPin: (contactId, pin) => this.contactPins.verifyPin(contactId, pin),
      isTestCallActive: () => transport.hasTestCall(),
      appCalls: this.deps.appCalls,
      smsMemory: this.smsMemory,
      callAgentModel: this.deps.callAgentModel,
    });
    client.on('dead', () => { void this.proc.restart('PhAP heartbeat lost'); });
    bridge.on('status', (s: PhoneBridgeStatus) => {
      if (!s.call) this.retryPendingRestartIfIdle();
      this.watchLink(s.link);
      this.emitStatus();
    });
    bridge.start();
    client.start();
    this.client = client;
    this.transport = transport;
    this.bridge = bridge;
    this.appliedLink = link;
  }

  /** Last resort: a link telefony hasn't brought back within the grace period gets telefony restarted. */
  private watchLink(link: PhoneBridgeStatus['link']): void {
    if (link !== 'down') { this.clearLinkDownTimer(); return; }
    if (this.linkDownTimer) return;
    const graceMs = this.deps.linkDownRestartMs ?? LINK_DOWN_RESTART_MS;
    this.linkDownTimer = setTimeout(() => {
      this.linkDownTimer = null;
      if (this.bridge?.getStatus().link !== 'down' || this.testCall) return;
      this.deps.log(`phone line: Bluetooth link down for ${Math.round(graceMs / 1000)} s; restarting telefony`);
      void this.proc.restart('Bluetooth link down').catch((err) => this.deps.log(`phone line: telefony restart failed: ${(err as Error).message}`));
    }, graceMs);
    this.linkDownTimer.unref?.();
  }

  private clearLinkDownTimer(): void {
    if (this.linkDownTimer) clearTimeout(this.linkDownTimer);
    this.linkDownTimer = null;
  }

  private async restartProcess(cfg: PhoneLineConfig, toml: string, executable: string): Promise<void> {
    this.pendingRestart = false;
    if (!executable || !cfg.transport) {
      this.deps.log('phone line: set the shared PhAP server executable and Bluetooth transport first');
      return;
    }
    await this.proc.start(cfg, executable);
    this.appliedToml = toml;
    this.appliedExecutable = executable;
  }

  private emitStatus(): void { this.emit('status', this.getStatus()); }
}
