import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { PhapEvent, PhapWelcome } from './phap-client.js';
import type { PhapLike } from './phone-bridge.js';

export const MAX_TEST_CALL_IDLE_MS = 10 * 60_000;
const MAX_UTTERANCE_LENGTH = 4_000;

export type TestCallStreamEvent =
  | { type: 'state'; callId: string; state: 'ringing' | 'active' | 'held' | 'ended'; reason?: string }
  | { type: 'message'; callId: string; speaker: 'caller' | 'agent'; text: string };
export type VirtualCallState = 'ringing' | 'active' | 'held' | 'ended';

export interface VirtualCallLineOptions {
  callerNumber: string;
  idleTimeoutMs?: number;
}

/** Text-only PhAP line used by the normal PhoneBridge inbound-call state machine. */
export class VirtualCallLine extends EventEmitter {
  readonly callId = `test-${randomUUID()}`;
  readonly callerNumber: string;
  readonly idleTimeoutMs: number;
  private readonly startedAt = Date.now();
  private readonly messages: Array<{ speaker: 'caller' | 'agent'; text: string }> = [];
  private readonly history: TestCallStreamEvent[] = [];
  private state: VirtualCallState = 'ringing';
  private sequence = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private streamClaimed = false;
  private streamClosed = false;
  private started = false;

  constructor(options: VirtualCallLineOptions) {
    super();
    const callerNumber = options.callerNumber.trim();
    if (!callerNumber || callerNumber.length > 32) throw new Error('A caller number of 1 to 32 characters is required.');
    this.callerNumber = callerNumber;
    this.idleTimeoutMs = Math.max(1, Math.min(options.idleTimeoutMs ?? MAX_TEST_CALL_IDLE_MS, MAX_TEST_CALL_IDLE_MS));
  }

  get callState(): VirtualCallState { return this.state; }
  isEnded(): boolean { return this.state === 'ended'; }
  hasStream(): boolean { return this.streamClaimed && !this.streamClosed; }

  start(): void {
    if (this.started) throw new Error('Test call already started.');
    this.started = true;
    this.emitPhap('call.ringing', { number: this.callerNumber });
    this.publish({ type: 'state', callId: this.callId, state: 'ringing' });
    this.armIdleTimer();
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (params.callId !== this.callId) throw new Error('Unknown virtual call.');
    switch (method) {
      case 'call.answer':
        if (this.state !== 'ringing') throw new Error(`Cannot answer a ${this.state} test call.`);
        this.state = 'active';
        this.emitPhap('call.state', { state: 'active' });
        this.publish({ type: 'state', callId: this.callId, state: 'active' });
        this.armIdleTimer();
        return {} as T;
      case 'call.reject':
      case 'call.hangup':
        this.end(method === 'call.reject' ? 'rejected' : 'hangup');
        return {} as T;
      case 'call.say': {
        if (this.state !== 'active' && this.state !== 'held') throw new Error(`Cannot reply to a ${this.state} test call.`);
        const text = typeof params.text === 'string' ? params.text : '';
        this.messages.push({ speaker: 'agent', text });
        this.publish({ type: 'message', callId: this.callId, speaker: 'agent', text });
        this.armIdleTimer();
        return {} as T;
      }
      case 'call.hold':
        if (this.state !== 'active') throw new Error(`Cannot hold a ${this.state} test call.`);
        this.state = 'held';
        this.emitPhap('call.state', { state: 'held' });
        this.publish({ type: 'state', callId: this.callId, state: 'held' });
        return {} as T;
      case 'call.resume':
        if (this.state !== 'held') throw new Error(`Cannot resume a ${this.state} test call.`);
        this.state = 'active';
        this.emitPhap('call.state', { state: 'active' });
        this.publish({ type: 'state', callId: this.callId, state: 'active' });
        this.armIdleTimer();
        return {} as T;
      case 'transcript.get':
        return { utterances: this.transcriptUtterances() } as T;
      default:
        throw new Error(`Operation ${method} is unavailable during a test call.`);
    }
  }

  submitUtterance(rawText: string): void {
    if (this.state !== 'active') throw new Error('The test call is not active.');
    const text = rawText.trim();
    if (!text || text.length > MAX_UTTERANCE_LENGTH) throw new Error(`Caller text must be 1 to ${MAX_UTTERANCE_LENGTH} characters.`);
    this.messages.push({ speaker: 'caller', text });
    this.publish({ type: 'message', callId: this.callId, speaker: 'caller', text });
    this.emitPhap('call.utterance', { text });
    this.armIdleTimer();
  }

  end(reason = 'ended'): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.publish({ type: 'state', callId: this.callId, state: 'ended', reason });
    this.emitPhap('call.state', { state: 'ended', reason });
    this.emit('ended', reason);
  }

  /** A stream is single-use; buffering closes the start/SSE race. */
  openStream(listener: (event: TestCallStreamEvent) => void): () => void {
    if (this.streamClaimed) throw new Error('Only one stream is allowed per test call.');
    this.streamClaimed = true;
    for (const event of this.history) listener(event);
    const onStream = (event: TestCallStreamEvent) => listener(event);
    this.on('stream', onStream);
    return () => {
      if (this.streamClosed) return;
      this.streamClosed = true;
      this.off('stream', onStream);
      this.emit('streamClosed');
    };
  }

  transcript(): Array<{ speaker: 'caller' | 'agent'; text: string }> {
    return this.messages.map((message) => ({ ...message }));
  }

  private transcriptUtterances(): Array<{ speaker: 'local' | 'remote'; text: string; startMs: number }> {
    return this.messages.map((message, index) => ({
      speaker: message.speaker === 'agent' ? 'local' : 'remote',
      text: message.text,
      startMs: Math.max(0, Date.now() - this.startedAt - (this.messages.length - index - 1)),
    }));
  }

  private publish(event: TestCallStreamEvent): void {
    this.history.push(event);
    this.emit('stream', event);
  }

  private emitPhap(type: string, fields: Record<string, unknown>): void {
    const event: PhapEvent = {
      seq: ++this.sequence,
      ts: new Date().toISOString(),
      type,
      callId: this.callId,
      test: true,
      ...fields,
    };
    this.emit('event', event);
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.end('idle_timeout'), this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }
}

/** Multiplexes one virtual call while enforcing that it cannot reach hardware. */
export class PhoneLineTransport extends EventEmitter implements PhapLike {
  private virtualCall: VirtualCallLine | null = null;
  private readonly physicalCallIds = new Set<string>();
  private readonly onPhysicalEvent = (event: PhapEvent) => {
    if (event.type === 'call.ringing') this.physicalCallIds.add(String(event.callId ?? ''));
    if (event.type === 'call.state' && event.state === 'ended') this.physicalCallIds.delete(String(event.callId ?? ''));
    if (this.virtualCall && event.type.startsWith('call.')) return;
    this.emit('event', event);
  };
  private readonly onPhysicalWelcome = (welcome: PhapWelcome) => {
    this.physicalCallIds.clear();
    for (const call of welcome.state.calls) this.physicalCallIds.add(call.callId);
    const virtual = this.virtualCall;
    if (!virtual) return this.emit('welcome', welcome);
    const calls = welcome.state.calls.filter((call) => call.callId !== virtual.callId);
    calls.push({ callId: virtual.callId, number: virtual.callerNumber, state: virtual.callState, direction: 'inbound' });
    this.emit('welcome', { ...welcome, state: { ...welcome.state, calls } });
  };
  private readonly onVirtualEvent = (event: PhapEvent) => this.emit('event', event);
  private readonly onConnected = () => this.emit('connected');
  private readonly onDisconnected = (...args: unknown[]) => this.emit('disconnected', ...args);
  private readonly onDead = (...args: unknown[]) => this.emit('dead', ...args);

  constructor(private readonly physical: PhapLike) {
    super();
    physical.on('event', this.onPhysicalEvent);
    physical.on('welcome', this.onPhysicalWelcome);
    physical.on('connected', this.onConnected);
    physical.on('disconnected', this.onDisconnected);
    physical.on('dead', this.onDead);
  }

  isConnected(): boolean { return this.physical.isConnected(); }
  hasTestCall(): boolean { return this.virtualCall !== null; }
  canStartTestCall(): boolean { return !this.virtualCall && this.physicalCallIds.size === 0; }

  attachTestCall(line: VirtualCallLine): void {
    if (!this.canStartTestCall()) throw new Error('The phone line is busy or already has a test call.');
    this.virtualCall = line;
    line.on('event', this.onVirtualEvent);
  }

  detachTestCall(callId: string): void {
    if (this.virtualCall?.callId !== callId) return;
    this.virtualCall.off('event', this.onVirtualEvent);
    this.virtualCall = null;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const virtual = this.virtualCall;
    if (!virtual) return this.physical.request<T>(method, params);
    if (params.callId === virtual.callId) return virtual.request<T>(method, params);
    if (method === 'sms.list' || method === 'sms.read') return this.physical.request<T>(method, params);
    throw new Error(`Operation ${method} is blocked while a test call is active.`);
  }

  dispose(): void {
    this.virtualCall?.off('event', this.onVirtualEvent);
    this.virtualCall = null;
    this.physical.off('event', this.onPhysicalEvent);
    this.physical.off('welcome', this.onPhysicalWelcome);
    this.physical.off('connected', this.onConnected);
    this.physical.off('disconnected', this.onDisconnected);
    this.physical.off('dead', this.onDead);
  }
}
