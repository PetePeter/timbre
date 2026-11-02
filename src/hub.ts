/**
 * Timbre's runtime: one PhoneLineService + one agent per configured phone.
 * Each phone is its own "operator session" (sessionId = phone id), so the
 * ported PhoneBridge needs no idea that several lines exist.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createOpenAiChatClient, type ChatClient } from './session/api/api-agent-loop.js';
import { PhoneLineService, type PhoneLineServiceDeps, type PhoneLineStatus } from './phone/phone-line-service.js';
import type { ApiLlm, ConfigStore, LlmConfig, PhoneEntry } from './config/timbre-config.js';
import { validateLlm } from './config/timbre-config.js';
import { sendSmsAction } from './actions/phone-actions.js';
import type { SmsAutoReplyAuthorization } from './phone/sms-auto-reply.js';
import { ApiAgent } from './agents/api-agent.js';
import { McpClient } from './agents/mcp-client.js';
import { DailyTokenBudget } from './agents/daily-token-budget.js';
import { CliAgent, expandArgs } from './agents/cli-agent.js';
import { buildClaudeCodeAgentOptions } from './agents/claude-code-preset.js';
import { buildCodexAgentOptions } from './agents/codex-preset.js';
import { ContactsStore } from './contacts/contacts-store.js';
import { projectPhoneContacts } from './phone/inbound-call-policy.js';
import type { PhoneAgent, SmsConversationContext } from './agents/phone-agent.js';
import type { PhoneLine } from './agents/phone-tools.js';
import type { ChatSendResult } from './session/chat/chat-bridge.js';
import type { PhoneContact } from './phone/phone-config.js';
import {
  AppCallNotFoundError, type AppCallAction, type CallAgentRequest, type LiveAudioEvent, type LiveCallEvent, type LiveCallStream,
} from './phone/phone-bridge.js';
import { AppCallDesk } from './phone/app-call-desk.js';
export type { LiveAudioEvent, LiveAudioFrame, LiveCallEvent, LiveCallSnapshot, LiveCallStream, LiveCallUtterance } from './phone/phone-bridge.js';
import type { RecordEvent, RecordPage, RecordQueryOptions, RecordSummary } from './records/event-types.js';
import { JsonlEventStore, subscribeRecordAppended } from './records/jsonl-event-store.js';
import { RecordQuery } from './records/record-query.js';
import { CallArtifactStore, type CallArtifacts } from './records/call-artifacts.js';
import { RecordingRetentionJob } from './records/recording-retention-job.js';
import { appendSpamHistoryEvent, createSpamHistoryIndex, readSpamHistoryByNumber, type SpamHistoryIndex } from './phone/spam-score.js';
import type { TestCallStreamEvent } from './phone/virtual-call-line.js';

/** What the hub needs from a line; PhoneLineService in production. */
export type HubLine = PhoneLine & {
  sendSms(contact: PhoneContact, text: string, interactionId?: string, clientName?: string): Promise<ChatSendResult>;
  sendSmsFromAction?(contact: PhoneContact, text: string, interactionId: string | undefined, clientName: string | undefined, authorization: SmsAutoReplyAuthorization): Promise<ChatSendResult>;
  startOwnerCallAgent(request: CallAgentRequest, requesterLabel: string, appId?: string): Promise<{ interactionId: string; state: 'dialing' }>;
  isCallHolder(sessionId: string): boolean;
  apply(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): PhoneLineStatus;
  restart(): Promise<void>;
  testSms(): Promise<unknown>;
  on?(event: 'status', listener: (status: PhoneLineStatus) => void): unknown;
  off?(event: 'status', listener: (status: PhoneLineStatus) => void): unknown;
  startTestCall?(callerNumber: string): { callId: string };
  openTestCallStream?(callId: string, listener: (event: TestCallStreamEvent) => void): () => void;
  submitTestCallUtterance?(callId: string, text: string): void;
  endTestCall?(callId: string): void;
  openLiveCallStream?(callId: string, listener: (event: LiveCallEvent) => void): LiveCallStream;
  openLiveAudioStream?(callId: string, listener: (event: LiveAudioEvent) => void): Promise<() => void>;
  takeoverLiveCall?(callId: string): Promise<void>;
  hangupCurrentCall?(callId: string): Promise<boolean>;
  appCallAction?(callId: string, appId: string, action: AppCallAction, arg?: string): Promise<void>;
};

export interface HubOptions {
  store: ConfigStore;
  dataDir: string;
  version: string;
  log: (msg: string) => void;
  /** The MCP URL a CLI agent is told to use, for a given phone. */
  mcpUrl: (phoneId: string) => string;
  /** Test seam: build the line for a phone (PhoneLineService by default). */
  createLine?: (deps: PhoneLineServiceDeps) => HubLine;
  /** Test seam: provide a separate model client for each phone's ApiAgent. */
  createApiClient?: (llm: ApiLlm, phoneId: string) => ChatClient;
  /** Test seam: how long a ringing call waits for an app to claim it. */
  appAnswerWindowMs?: number;
}

interface Slot {
  line: HubLine;
  agent: PhoneAgent | null;
  agentKey: string;
  token: string;
  pendingAgentSync: boolean;
  statusListener?: (status: PhoneLineStatus) => void;
}

export type HubRecordEventListener = (phoneId: string, event: RecordEvent) => void;

export interface PhoneStatus { id: string; name: string; llm: string; agentKind: LlmConfig['kind'] | null; agentProblem: string; line: PhoneLineStatus }

export class Hub {
  private readonly slots = new Map<string, Slot>();
  private readonly recordStore: JsonlEventStore;
  private readonly recordQuery: RecordQuery;
  private readonly callArtifacts = new Map<string, CallArtifactStore>();
  private readonly spamHistoryIndexes = new Map<string, SpamHistoryIndex>();
  private readonly recordEventListeners = new Set<HubRecordEventListener>();
  private readonly appCallDesks = new Map<string, AppCallDesk>();
  private readonly retention: RecordingRetentionJob;
  private unsubscribeRecordAppended: (() => void) | null = null;

  constructor(private readonly opts: HubOptions) {
    this.recordStore = new JsonlEventStore(opts.dataDir, opts.log);
    this.recordQuery = new RecordQuery(this.recordStore);
    this.retention = new RecordingRetentionJob({
      dataDir: opts.dataDir,
      getPhones: () => this.opts.store.get().phones,
      recordEvent: (phoneId, event) => this.recordStore.append(phoneId, event),
      log: opts.log,
    });
  }

  /** Bring lines and agents in line with the saved config (start, restart, drop). */
  async apply(): Promise<void> {
    this.watchRecordAppended();
    void this.retention.start().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.opts.log(`recording retention start failed: ${detail}`);
    });
    const cfg = this.opts.store.get();
    const ids = new Set(cfg.phones.map((p) => p.id));
    for (const [id, slot] of this.slots) {
      if (ids.has(id)) continue;
      this.detachAgentSyncWatcher(slot);
      await slot.agent?.stop();
      await slot.line.stop();
      this.slots.delete(id);
      this.spamHistoryIndexes.delete(id);
    }
    for (const phone of cfg.phones) this.slots.get(phone.id) ?? this.createSlot(phone.id);
    for (const phone of cfg.phones) {
      const slot = this.slots.get(phone.id)!;
      await this.syncAgent(phone, slot);
    }
    // A second pass lets earlier agents see targets that were started later in the first pass.
    for (const phone of cfg.phones) {
      const slot = this.slots.get(phone.id)!;
      await this.syncAgent(phone, slot);
      await slot.line.apply();
    }
  }

  async stop(): Promise<void> {
    await this.retention.stop();
    for (const slot of this.slots.values()) {
      this.detachAgentSyncWatcher(slot);
      await slot.agent?.stop();
      await slot.line.stop();
    }
    this.slots.clear();
    this.unsubscribeRecordAppended?.();
    this.unsubscribeRecordAppended = null;
    this.recordEventListeners.clear();
    this.spamHistoryIndexes.clear();
  }

  /** Subscribe to appends for phones currently configured in this hub. */
  subscribeRecordEvents(listener: HubRecordEventListener): () => void {
    this.recordEventListeners.add(listener);
    return () => this.recordEventListeners.delete(listener);
  }

  status(): PhoneStatus[] {
    const { phones, llms } = this.opts.store.get();
    return phones.map((p) => {
      const llm = llms.find((l) => l.id === p.llmId);
      const slot = this.slots.get(p.id);
      return {
        id: p.id, name: p.name, llm: llm?.name ?? '', agentKind: slot?.agent ? llm?.kind ?? null : null,
        agentProblem: llm ? validateLlm(llm).map((f) => `${llm.name}: ${f} is required`).join('; ') : 'No LLM picked',
        line: slot?.line.getStatus() ?? emptyLineStatus(),
      };
    });
  }

  line(phoneId: string): HubLine | undefined {
    const slot = this.slots.get(phoneId);
    if (!slot) return undefined;
    const routed = this.agentLine(phoneId);
    return {
      ...routed,
      isCallHolder: (sessionId) => slot.line.isCallHolder(sessionId),
      apply: () => slot.line.apply(),
      stop: () => slot.line.stop(),
      getStatus: () => slot.line.getStatus(),
      restart: () => slot.line.restart(),
      testSms: () => slot.line.testSms(),
      sendSms: (contact, text, interactionId, clientName) => slot.line.sendSms(contact, text, interactionId, clientName),
      sendSmsFromAction: slot.line.sendSmsFromAction
        ? (contact, text, interactionId, clientName, authorization) => slot.line.sendSmsFromAction!(contact, text, interactionId, clientName, authorization)
        : undefined,
      startOwnerCallAgent: (request, requesterLabel, appId) => slot.line.startOwnerCallAgent(request, requesterLabel, appId),
      openLiveCallStream: slot.line.openLiveCallStream
        ? (callId, listener) => slot.line.openLiveCallStream!(callId, listener)
        : undefined,
      openLiveAudioStream: slot.line.openLiveAudioStream
        ? (callId, listener) => slot.line.openLiveAudioStream!(callId, listener)
        : undefined,
      takeoverLiveCall: slot.line.takeoverLiveCall
        ? (callId) => slot.line.takeoverLiveCall!(callId)
        : undefined,
      hangupCurrentCall: slot.line.hangupCurrentCall
        ? (callId) => slot.line.hangupCurrentCall!(callId)
        : undefined,
    };
  }

  startTestCall(phoneId: string, callerNumber: string): { callId: string } {
    const start = this.slots.get(phoneId)?.line.startTestCall;
    if (!start) throw new Error('Test calls are unavailable for this phone.');
    return start.call(this.slots.get(phoneId)!.line, callerNumber);
  }

  openTestCallStream(phoneId: string, callId: string, listener: (event: TestCallStreamEvent) => void): () => void {
    const line = this.slots.get(phoneId)?.line;
    if (!line?.openTestCallStream) throw new Error('Test calls are unavailable for this phone.');
    return line.openTestCallStream(callId, listener);
  }

  submitTestCallUtterance(phoneId: string, callId: string, text: string): void {
    const line = this.slots.get(phoneId)?.line;
    if (!line?.submitTestCallUtterance) throw new Error('Test calls are unavailable for this phone.');
    line.submitTestCallUtterance(callId, text);
  }

  endTestCall(phoneId: string, callId: string): void {
    const line = this.slots.get(phoneId)?.line;
    if (!line?.endTestCall) throw new Error('Test calls are unavailable for this phone.');
    line.endTestCall(callId);
  }

  openLiveCallStream(phoneId: string, callId: string, listener: (event: LiveCallEvent) => void): LiveCallStream {
    const line = this.slots.get(phoneId)?.line;
    if (!line?.openLiveCallStream) throw new Error('Live calls are unavailable for this phone.');
    return line.openLiveCallStream(callId, listener);
  }

  openLiveAudioStream(phoneId: string, callId: string, listener: (event: LiveAudioEvent) => void): Promise<() => void> {
    const line = this.slots.get(phoneId)?.line;
    if (!line?.openLiveAudioStream) throw new Error('Live audio is unavailable for this phone.');
    return line.openLiveAudioStream(callId, listener);
  }

  takeoverLiveCall(phoneId: string, callId: string): Promise<void> {
    const line = this.slots.get(phoneId)?.line;
    if (!line?.takeoverLiveCall) throw new Error('Live call takeover is unavailable for this phone.');
    return line.takeoverLiveCall(callId);
  }

  /** The phone's inbound-call desk for apps; kept across line restarts. */
  appCalls(phoneId: string): AppCallDesk {
    let desk = this.appCallDesks.get(phoneId);
    if (!desk) {
      desk = new AppCallDesk({ windowMs: this.opts.appAnswerWindowMs, log: this.opts.log });
      this.appCallDesks.set(phoneId, desk);
    }
    return desk;
  }

  appCallAction(phoneId: string, callId: string, appId: string, action: AppCallAction, arg?: string): Promise<void> {
    const line = this.slots.get(phoneId)?.line;
    if (!line?.appCallAction) return Promise.reject(new AppCallNotFoundError());
    return line.appCallAction(callId, appId, action, arg);
  }

  agent(phoneId: string): PhoneAgent | null { return this.slots.get(phoneId)?.agent ?? null; }

  listRecords(phoneId: string, options: RecordQueryOptions = {}): RecordPage | null {
    if (!this.phone(phoneId)) return null;
    return this.recordQuery.list(phoneId, options);
  }

  getRecord(phoneId: string, interactionId: string): RecordSummary | null {
    if (!this.phone(phoneId)) return null;
    return this.recordQuery.get(phoneId, interactionId);
  }

  readRecordEvents(phoneId: string): RecordEvent[] | null {
    if (!this.phone(phoneId)) return null;
    return this.recordStore.readEvents(phoneId);
  }

  getCallArtifacts(phoneId: string, interactionId: string): CallArtifacts | null {
    if (!this.phone(phoneId)) return null;
    return this.callArtifactStore(phoneId).get(interactionId);
  }

  callRecordingPath(phoneId: string, interactionId: string): string | null {
    if (!this.phone(phoneId)) return null;
    return this.callArtifactStore(phoneId).audioPath(interactionId);
  }

  /** The phone whose MCP token this is; null when it matches none. */
  phoneForToken(token: string): string | null {
    for (const [id, slot] of this.slots) if (token && slot.token === token) return id;
    return null;
  }

  /** The in-memory credential for one phone's MCP endpoint. */
  phoneMcpToken(phoneId: string): string | null {
    return this.slots.get(phoneId)?.token ?? null;
  }

  private phone(id: string): PhoneEntry | undefined { return this.opts.store.get().phones.find((p) => p.id === id); }

  private callArtifactStore(phoneId: string): CallArtifactStore {
    let store = this.callArtifacts.get(phoneId);
    if (!store) {
      store = new CallArtifactStore(this.recordingsDirectory(phoneId));
      this.callArtifacts.set(phoneId, store);
    }
    return store;
  }

  private recordingsDirectory(phoneId: string): string {
    return path.resolve(this.opts.dataDir, 'phones', phoneId, 'recordings');
  }

  private createSlot(phoneId: string): Slot {
    const dir = path.join(this.opts.dataDir, 'phones', phoneId);
    const deps: PhoneLineServiceDeps = {
      phoneId,
      getConfig: () => {
        const line = this.phone(phoneId)!.line;
        const contacts = new ContactsStore(this.opts.dataDir, phoneId, line.countryCode, this.opts.log).list();
        return { ...line, contacts: projectPhoneContacts(line, contacts) };
      },
      saveConfig: (line) => {
        const cfg = this.opts.store.get();
        this.opts.store.save({ ...cfg, phones: cfg.phones.map((p) => (p.id === phoneId ? { ...p, line } : p)) });
      },
      getExecutable: () => this.opts.store.get().telefony.executable,
      telefonyConfigPath: path.join(dir, 'telefony.toml'),
      recordingsDir: this.recordingsDirectory(phoneId),
      defaultTranscriptDir: path.join(dir, 'transcripts'),
      getAppVersion: () => this.opts.version,
      getOperatorId: () => phoneId,
      sessionName: (id) => this.phone(id)?.name,
      deliver: async (sessionId, text, context?: SmsConversationContext) => {
        const agent = this.slots.get(sessionId)?.agent;
        if (!agent) throw new Error('No LLM is answering this phone');
        await agent.deliver(text, context);
      },
      log: (m) => this.opts.log(`[${this.phone(phoneId)?.name ?? phoneId}] ${m}`),
      recordEvent: (event: RecordEvent) => this.recordStore.append(phoneId, event),
      readSpamHistory: (number) => this.spamHistory(phoneId, number),
      lookupAddressBook: (number) => {
        const phone = this.phone(phoneId);
        if (!phone) return [];
        const contacts = new ContactsStore(this.opts.dataDir, phoneId, phone.line.countryCode, this.opts.log);
        return number === undefined ? contacts.list() : contacts.findByNumber(number);
      },
      sendSmsAction: (request) => {
        const phone = this.phone(phoneId);
        if (!phone) return Promise.resolve({ sent: false, reason: 'phone line unavailable' });
        return sendSmsAction({ hub: this }, phone, request.to, request.text, request.clientName, request.autoReply, request.interactionId);
      },
      callAgentModel: () => {
        const phone = this.phone(phoneId);
        return phone ? this.apiClient(phone.llmId, phoneId) : null;
      },
      appCalls: this.appCalls(phoneId),
    };
    const line = this.opts.createLine?.(deps) ?? new PhoneLineService(deps);
    const slot: Slot = { line, agent: null, agentKey: '', token: randomBytes(24).toString('base64url'), pendingAgentSync: false };
    this.slots.set(phoneId, slot);
    if (line.on && line.off) {
      const listener = (status: PhoneLineStatus) => {
        if (!slot.pendingAgentSync || status.line?.call) return;
        slot.pendingAgentSync = false;
        const currentPhone = this.phone(phoneId);
        if (!currentPhone || this.slots.get(phoneId) !== slot) return;
        void this.syncAgent(currentPhone, slot).catch((error) => {
          this.opts.log(`deferred agent refresh failed for ${phoneId}: ${error instanceof Error ? error.message : String(error)}`);
        });
      };
      line.on('status', listener);
      slot.statusListener = listener;
    }
    return slot;
  }

  private detachAgentSyncWatcher(slot: Slot): void {
    slot.pendingAgentSync = false;
    if (slot.statusListener) slot.line.off?.('status', slot.statusListener);
    slot.statusListener = undefined;
  }

  private watchRecordAppended(): void {
    if (this.unsubscribeRecordAppended) return;
    this.unsubscribeRecordAppended = subscribeRecordAppended((dataDir, phoneId, event) => {
      if (path.resolve(dataDir) !== path.resolve(this.opts.dataDir)) return;
      const index = this.spamHistoryIndexes.get(phoneId);
      if (index) appendSpamHistoryEvent(index, event);
      if (!this.phone(phoneId)) return;
      for (const listener of this.recordEventListeners) {
        try { listener(phoneId, event); } catch { /* record observers must not affect durable event writes */ }
      }
    });
  }

  private spamHistory(phoneId: string, rawNumber: string): readonly RecordEvent[] {
    const phone = this.phone(phoneId);
    if (!phone) return [];
    let index = this.spamHistoryIndexes.get(phoneId);
    if (!index || index.countryCode !== phone.line.countryCode) {
      const events = this.readRecordEvents(phoneId);
      if (!events) return [];
      index = createSpamHistoryIndex(phone.line.countryCode, events);
      this.spamHistoryIndexes.set(phoneId, index);
    }
    return readSpamHistoryByNumber(index, rawNumber);
  }

  private apiClient(llmId: string, phoneId?: string): ChatClient | null {
    const llm = this.opts.store.get().llms.find((l) => l.id === llmId);
    if (!llm || llm.kind !== 'api' || validateLlm(llm).length) return null;
    if (phoneId && this.opts.createApiClient) return this.opts.createApiClient(llm, phoneId);
    return createOpenAiChatClient({
      baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.apiKey || undefined, reasoningEffort: llm.reasoningEffort,
    });
  }

  /** (Re)build the phone's agent only when its LLM, sessions, or MCP tools changed. */
  private async syncAgent(phone: PhoneEntry, slot: Slot): Promise<void> {
    const cfg = this.opts.store.get();
    const llm = cfg.llms.find((l) => l.id === phone.llmId);
    const sessions = cfg.phones
      .filter((candidate) => candidate.id !== phone.id && this.slots.get(candidate.id)?.agent)
      .map(({ id, name }) => ({ id, name }));
    const key = llm && !validateLlm(llm).length
      ? JSON.stringify([
        llm, sessions, phone.mcpServers, llm.kind === 'cli' ? this.opts.mcpUrl(phone.id) : null,
        llm.kind === 'cli' && (llm.preset === 'claude-code' || llm.preset === 'codex')
          ? {
            persona: phone.line.persona,
            ...(llm.preset === 'claude-code' ? { extraAllowedTools: llm.extraAllowedTools } : {}),
          }
          : null,
      ])
      : '';
    if (key === slot.agentKey) { slot.pendingAgentSync = false; return; }
    if (slot.agent && slot.line.getStatus().line?.call) {
      slot.pendingAgentSync = true;
      return;
    }
    slot.pendingAgentSync = false;
    await slot.agent?.stop();
    slot.agent = null;
    slot.agentKey = key;
    if (!llm || !key) return;
    const log = (m: string) => this.opts.log(`[${phone.name}] ${m}`);
    if (llm.kind === 'api') {
      const phoneDir = path.join(this.opts.dataDir, 'phones', phone.id);
      slot.agent = new ApiAgent({
        client: this.apiClient(llm.id, phone.id)!, line: this.agentLine(phone.id), sessionId: phone.id,
        name: phone.line.persona.name, mode: llm.mode ?? 'full', sessions,
        getPersona: () => {
          const persona = this.opts.store.get().phones.find((entry) => entry.id === phone.id)?.line.persona ?? phone.line.persona;
          return { name: persona.name, tone: persona.tone, instructions: persona.instructions };
        },
        budget: new DailyTokenBudget(path.join(phoneDir, 'api-usage.json'), llm.dailyTokenLimit ?? 0, undefined, log), log,
        externalTools: phone.mcpServers.length ? new McpClient(phone.mcpServers, (message) => log(message)) : undefined,
      });
      return;
    }
    const mcpUrl = this.opts.mcpUrl(phone.id);
    const mcpConfig = path.join(this.opts.dataDir, 'phones', phone.id, 'mcp.json');
    if (llm.preset !== 'claude-code') {
      mkdirSync(path.dirname(mcpConfig), { recursive: true });
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { timbre: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${slot.token}` } } } }, null, 2));
    }
    try {
      const options = llm.preset === 'claude-code'
        ? buildClaudeCodeAgentOptions({ llm, phone, dataDir: this.opts.dataDir, mcpUrl, token: slot.token, log })
        : llm.preset === 'codex'
          ? buildCodexAgentOptions({ llm, phone, dataDir: this.opts.dataDir, mcpUrl, token: slot.token, log })
          : {
          command: llm.command, args: expandArgs(llm.args, { mcpUrl, mcpConfig }), cwd: llm.cwd,
          env: { TIMBRE_MCP_URL: mcpUrl, TIMBRE_MCP_TOKEN: slot.token }, log,
          };
      slot.agent = new CliAgent(options);
    } catch (err) {
      log(`could not start ${llm.command}: ${(err as Error).message}`);
    }
  }

  /** Routes a transferred call back to its owning line while each phone keeps its own tools and budget. */
  private agentLine(phoneId: string): PhoneLine {
    const own = () => this.slots.get(phoneId)?.line;
    const active = (sessionId: string) => {
      for (const slot of this.slots.values()) if (slot.line.isCallHolder(sessionId)) return slot.line;
      return undefined;
    };
    return {
      sendToSession: (message) => (active(message.sessionId) ?? own())?.sendToSession(message)
        ?? Promise.resolve({ sent: false, reason: 'phone line unavailable' }),
      hangup: (sessionId) => (active(sessionId) ?? own())?.hangup(sessionId)
        ?? Promise.reject(new Error('Phone line unavailable.')),
      inbox: () => own()?.inbox() ?? Promise.resolve([]),
      startCallAgent: (sessionId, request, smsInteractionId) => (smsInteractionId ? own() : active(sessionId) ?? own())?.startCallAgent(sessionId, request, smsInteractionId)
        ?? Promise.reject(new Error('Phone line unavailable.')),
      authorizeSmsAction: (sessionId, interactionId, consumeMcpAction) => own()?.authorizeSmsAction?.(sessionId, interactionId, consumeMcpAction)
        ?? { required: true, allowed: false, refusal: 'SMS action authorization is unavailable.' },
      authorizeSmsReply: (sessionId, sourceInteractionId, replyInteractionId, consumeMcpAction) => own()?.authorizeSmsReply?.(sessionId, sourceInteractionId, replyInteractionId, consumeMcpAction)
        ?? { required: true, allowed: false, refusal: 'SMS reply authorization is unavailable.' },
      refuseSmsAction: (sessionId, interactionId, refusal) => own()?.refuseSmsAction?.(sessionId, interactionId, refusal)
        ?? Promise.resolve(),
      verifyCaller: (sessionId) => (active(sessionId) ?? own())?.verifyCaller(sessionId)
        ?? Promise.reject(new Error('Phone line unavailable.')),
      isCallerVerified: (sessionId) => (active(sessionId) ?? own())?.isCallerVerified(sessionId) ?? false,
      transfer: async (from, to, line) => {
        const target = this.slots.get(to);
        if (to === from || !target?.agent || !this.phone(to)) return false;
        const source = active(from);
        if (!source) return false;
        return await source.transfer(from, to, line);
      },
      enterMessageMode: (sessionId) => active(sessionId)?.enterMessageMode(sessionId) ?? false,
      reportCallOutcome: async (sessionId, interactionId, outcome) => {
        for (const slot of this.slots.values()) {
          if (await slot.line.reportCallOutcome(sessionId, interactionId, outcome)) return true;
        }
        return false;
      },
      recordAgentToolCall: (interactionId, toolName, outcome) => {
        this.slots.get(phoneId)?.line.recordAgentToolCall?.(interactionId, toolName, outcome);
      },
    };
  }
}

function emptyLineStatus(): PhoneLineStatus {
  return { enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' };
}
