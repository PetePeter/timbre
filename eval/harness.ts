/**
 * Runs one scenario against one model through the real phone stack:
 * PhapClient -> PhoneBridge -> ApiAgent (inbound) or CallAgent (outbound).
 * Only the hardware edge is fake: a PhAP server whose far end is scripted.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PhapClient } from '../src/phone/phap-client.js';
import { PhoneBridge } from '../src/phone/phone-bridge.js';
import { resolvePhoneLineConfig, type PhoneLineConfig } from '../src/phone/phone-config.js';
import { projectPhoneContacts } from '../src/phone/inbound-call-policy.js';
import { ApiAgent } from '../src/agents/api-agent.js';
import type { PhoneLine } from '../src/agents/phone-tools.js';
import type { AddressBookContact } from '../src/contacts/contact.js';
import type { ChatClient, ChatMessage, CompletionResult, ToolSpec } from '../src/session/api/api-agent-loop.js';
import { FakePhapServer } from '../tests/helpers/fake-phap-server.js';

export const OWNER = '+61491570156';
export const CALL_ID = 'c1';
const PHONE_ID = 'eval-phone';

export interface ToolUse { name: string; args: Record<string, unknown> }
export type LineEntry = { speaker: 'far' | 'agent'; text: string } | { speaker: 'keys'; text: string } | { speaker: 'event'; text: string };

/** One model completion, kept as a training sample. */
export interface Sample { messages: ChatMessage[]; tools: ToolSpec[]; response: CompletionResult['message']; ms: number }

export interface RunResult {
  transcript: LineEntry[];
  said: string[];
  keys: string;
  tools: ToolUse[];
  methods: string[];
  samples: Sample[];
  errors: string[];
}

export interface Scenario {
  id: string;
  title: string;
  direction: 'inbound' | 'outbound';
  /** Inbound caller number. */
  caller?: string;
  /** Outbound task, as the owner would ask for it. */
  task?: string;
  /** Outbound callee. */
  to?: string;
  addressBook?: AddressBookContact[];
  play(far: FarEnd): Promise<void>;
  checks: Array<{ name: string; pass(result: RunResult): boolean }>;
}

/** Records every completion and the tool calls the model asked for. */
class RecordingClient implements ChatClient {
  readonly samples: Sample[] = [];
  readonly tools: ToolUse[] = [];
  constructor(private readonly inner: ChatClient) {}
  async complete(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<CompletionResult> {
    const start = Date.now();
    const result = await this.inner.complete(messages, tools, signal);
    this.samples.push({ messages: structuredClone(messages), tools, response: result.message, ms: Date.now() - start });
    for (const call of result.message.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>; } catch { /* scored as given */ }
      this.tools.push({ name: call.function.name, args });
    }
    return result;
  }
}

/** The scripted other end of the call: speaks, listens, hangs up. */
export class FarEnd {
  readonly transcript: LineEntry[] = [];
  private cursor = 0;
  private sayCursor = 0;
  ended = false;

  constructor(private readonly server: FakePhapServer) {}

  /** Far-end speech, as speech-to-text would report it. */
  speak(text: string): void {
    this.sync();
    this.transcript.push({ speaker: 'far', text });
    this.server.emit('call.utterance', { callId: CALL_ID, text });
  }

  answer(): void {
    this.transcript.push({ speaker: 'event', text: 'far end answered' });
    this.server.emit('call.state', { callId: CALL_ID, state: 'active' });
  }

  hangUp(reason = 'remote'): void {
    this.sync();
    if (this.ended) return;
    this.ended = true;
    this.transcript.push({ speaker: 'event', text: `far end hung up (${reason})` });
    this.server.emit('call.state', { callId: CALL_ID, state: 'ended', reason });
  }

  /** The next thing the agent says, or null if it stays quiet for `ms` (or the call ends). */
  async nextSay(ms = 60_000): Promise<string | null> {
    return this.waitFor(ms, () => {
      const says = this.says();
      if (says.length > this.sayCursor) return says[this.sayCursor++];
      return undefined;
    });
  }

  /** The agent's whole turn: its first line, plus any that follow within `settleMs`. */
  async reply(ms = 90_000, settleMs = 2_500): Promise<string | null> {
    const first = await this.nextSay(ms);
    if (first === null) return null;
    const lines = [first];
    for (let more = await this.nextSay(settleMs); more !== null; more = await this.nextSay(settleMs)) lines.push(more);
    return lines.join(' ');
  }

  /** Keys pressed since the last call, once at least one arrives (or null). */
  async nextKeys(ms = 60_000): Promise<string | null> {
    return this.waitFor(ms, () => {
      const keys = this.server.requests.filter((r) => r.method === 'call.sendDtmf');
      const fresh = keys.slice(this.keyCursor);
      if (!fresh.length) return undefined;
      this.keyCursor = keys.length;
      return fresh.map((r) => String(r.params.digits ?? '')).join('');
    });
  }
  private keyCursor = 0;

  /** Waits for a PhAP method (e.g. conference.create); true if seen. */
  async sawMethod(method: string, ms = 60_000): Promise<boolean> {
    return (await this.waitFor(ms, () => (this.server.requests.some((r) => r.method === method) ? true : undefined))) === true;
  }

  /** Quiet for `ms`: true if the agent said nothing meanwhile. */
  async staysQuiet(ms: number): Promise<boolean> {
    return (await this.nextSay(ms)) === null;
  }

  pause(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

  /** Moves agent actions recorded by the PhAP server into the transcript, in order. */
  sync(): void {
    const requests = this.server.requests;
    for (; this.cursor < requests.length; this.cursor++) {
      const { method, params } = requests[this.cursor];
      if (method === 'call.say') this.transcript.push({ speaker: 'agent', text: String(params.text ?? '') });
      else if (method === 'call.sendDtmf') this.transcript.push({ speaker: 'keys', text: String(params.digits ?? '') });
      else if (method === 'call.hangup') { this.ended = true; this.transcript.push({ speaker: 'event', text: 'agent hung up' }); }
      else if (method === 'conference.create') this.transcript.push({ speaker: 'event', text: `conference ${String(params.number ?? '')}` });
    }
  }

  private says(): string[] {
    return this.server.requests.filter((r) => r.method === 'call.say').map((r) => String(r.params.text ?? ''));
  }

  private async waitFor<T>(ms: number, probe: () => T | undefined): Promise<T | null> {
    const until = Date.now() + ms;
    for (;;) {
      this.sync();
      const value = probe();
      if (value !== undefined) return value;
      if (this.ended || Date.now() > until) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function lineConfig(addressBook: AddressBookContact[]): PhoneLineConfig {
  const cfg = resolvePhoneLineConfig({
    enabled: true, countryCode: '+61',
    recordingNotice: { enabled: false, text: '' },
    masters: { callIn: true, callOut: true, smsIn: true, smsOut: true, conference: true },
    screening: { allow: [], block: [], acceptPrivate: true, unknownCallers: 'allow' },
    contacts: [
      { label: 'Me', pattern: OWNER, role: 'owner', pin: '', callIn: true, callOut: true, smsIn: true, smsOut: true, conf: true },
      // Phone-book contacts are reachable for transfers, as an owner would mark them.
      ...addressBook.filter((c) => !c.isUser).map((c) => ({
        label: c.name, pattern: c.numbers[0], role: 'trusted', callIn: true, callOut: true, smsIn: false, smsOut: false, conf: true,
      })),
    ],
    limits: { callsPerHour: 100, smsPerHour: 100, maxCallMin: 0, quietStart: '', quietEnd: '' },
    voice: { tts: '', piperModel: '', sapiVoice: '', sttModel: 'eval-stt' },
    persona: { name: 'Timbre', tone: 'friendly and brief', instructions: 'You answer calls for Oscar. Oscar is busy; take messages or transfer when asked.' },
  });
  return { ...cfg, contacts: projectPhoneContacts(cfg, addressBook) };
}

export async function runScenario(scenario: Scenario, model: ChatClient): Promise<RunResult> {
  const server = new FakePhapServer();
  await server.listen();
  server.handlers.set('call.dial', () => ({ callId: CALL_ID }));
  server.handlers.set('transcript.get', () => ({ callId: CALL_ID, utterances: [] }));
  const client = new PhapClient({ uri: server.uri, token: 'tok', clientVersion: 'eval', heartbeatS: 1, baseDelayMs: 10 });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-eval-'));
  const recorder = new RecordingClient(model);
  const errors: string[] = [];
  const addressBook = [
    { id: 'owner-id', name: 'Me', numbers: [OWNER], group: '', trusted: true, isUser: true },
    ...(scenario.addressBook ?? []),
  ];
  const cfg = lineConfig(addressBook);
  let agent: ApiAgent | null = null;
  const bridge: PhoneBridge = new PhoneBridge({
    client,
    phoneId: PHONE_ID,
    getConfig: () => cfg,
    sendSmsAction: async () => ({ sent: false, reason: 'SMS is off during evaluation' }),
    getOperatorId: () => PHONE_ID,
    sessionName: () => 'Timbre',
    deliver: async (_sessionId, text) => { await agent?.deliver(text); },
    defaultTranscriptDir: dir,
    recordingsDir: path.join(dir, 'recordings'),
    smsPollMs: 0,
    callAgentModel: () => recorder,
    lookupAddressBook: (number) => addressBook.filter((c) => number === undefined || c.numbers.includes(number)),
    recordEvent: () => undefined,
    log: (message) => { if (/fail|error/i.test(message)) errors.push(message); },
  });
  agent = new ApiAgent({
    client: recorder, line: bridge as unknown as PhoneLine, sessionId: PHONE_ID, name: 'Timbre',
    log: (message) => errors.push(message),
  });
  const far = new FarEnd(server);
  try {
    bridge.start();
    client.start();
    await waitUntil(() => client.isConnected(), 5_000);
    if (scenario.direction === 'inbound') {
      server.emit('call.ringing', { callId: CALL_ID, number: scenario.caller, allowed: true });
      await server.waitFor('call.answer', 1, 10_000);
      far.answer();
    } else {
      await bridge.startOwnerCallAgent({ to: scenario.to!, task: scenario.task! }, 'Oscar');
      await server.waitFor('call.dial', 1, 10_000);
      await far.pause(50);
      far.answer();
    }
    await scenario.play(far);
    far.hangUp('script end');
    await Promise.race([agent.idle(), far.pause(30_000)]);
    far.sync();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    await agent.stop();
    bridge.stop();
    client.stop();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    transcript: far.transcript,
    said: far.transcript.filter((e) => e.speaker === 'agent').map((e) => e.text),
    keys: far.transcript.filter((e) => e.speaker === 'keys').map((e) => e.text).join(''),
    tools: recorder.tools,
    methods: server.requests.map((r) => r.method),
    samples: recorder.samples,
    errors,
  };
}

async function waitUntil(pred: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out waiting for the phone link');
    await new Promise((r) => setTimeout(r, 10));
  }
}
