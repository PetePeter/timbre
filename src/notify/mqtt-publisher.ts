import { connect, type MqttClient } from 'mqtt';
import type { MqttConfig } from '../config/timbre-config.js';
import type { RecordEvent } from '../records/event-types.js';

const ALLOWED_EVENTS = new Set<RecordEvent['type']>([
  'call.started', 'call.answered', 'call.ended', 'call.outcome', 'call.transferred',
  'call.agent_reported', 'call.agent_question', 'conference.added', 'sms.received', 'sms.sent',
]);
const CONNECTION_FAILURE_LOG_INTERVAL_MS = 60_000;

export interface MqttPhone { id: string; name: string }
type CallState = 'idle' | 'ringing' | 'dialing' | 'active';
/** One call on a phone; a phone can hold several (call waiting, a caller turned away busy). */
interface LineCall { state: CallState; number: string | null; since: number }
/** The phone's state is its most engaged live call. */
const STATE_RANK: Record<CallState, number> = { idle: 0, ringing: 1, dialing: 2, active: 3 };
/** A call still ringing or dialing after this long missed its end event (e.g. the answer failed) and no longer counts. */
const UNANSWERED_CALL_MAX_MS = 3 * 60_000;

/** Readable topic segment per phone: its slugged name, or its id when the name is blank or shared. */
function topicNames(phones: MqttPhone[]): Map<string, string> {
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const counts = new Map<string, number>();
  for (const p of phones) counts.set(slug(p.name), (counts.get(slug(p.name)) ?? 0) + 1);
  return new Map(phones.map((p) => {
    const s = slug(p.name);
    return [p.id, s && counts.get(s) === 1 ? s : p.id];
  }));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function eventNumber(details: Record<string, unknown>): string | null {
  return text(details.from) ?? text(details.to) ?? text(details.number);
}

export class MqttPublisher {
  private client: MqttClient | null = null;
  private configKey: string | null = null;
  private topicPrefix = '';
  private phoneTopics = new Map<string, string>();
  private readonly lines = new Map<string, Map<string, LineCall>>();
  /** Retained state topics of renamed or removed phones (or an old prefix), cleared once connected. */
  private readonly staleStateTopics = new Set<string>();
  private lastConnectionFailureAt: number | null = null;
  private connectionFailureActive = false;

  constructor(private readonly log: (message: string) => void, private readonly now: () => number = Date.now) {}

  configure(config: MqttConfig, phones: MqttPhone[] = []): void {
    const previousStateTopics = this.topicPrefix ? this.currentStateTopics() : [];
    this.phoneTopics = topicNames(phones);
    const key = JSON.stringify(config);
    if (key !== this.configKey) {
      this.configKey = key;
      this.closeClient();
      this.topicPrefix = config.enabled ? config.topicPrefix : '';
      this.lastConnectionFailureAt = null;
      this.connectionFailureActive = false;
      if (config.enabled) this.connect(config);
    }
    const current = new Set(this.currentStateTopics());
    for (const topic of previousStateTopics) if (!current.has(topic)) this.staleStateTopics.add(topic);
    if (this.client?.connected) this.publishCurrentState(this.client);
  }

  private connect(config: MqttConfig): void {
    try {
      const client = connect(config.url, {
        reconnectPeriod: 1000,
        will: { topic: this.statusTopic(), payload: Buffer.from('offline'), qos: 1, retain: true },
        ...(config.username ? { username: config.username } : {}),
        ...(config.password ? { password: config.password } : {}),
      });
      this.client = client;
      client.on('error', (error) => {
        if (this.client === client) this.logConnectionFailure(error);
      });
      client.on('connect', () => {
        if (this.client !== client) return;
        this.logConnectionRestored();
        this.publishCurrentState(client);
      });
    } catch (error) {
      this.logConnectionFailure(error);
    }
  }

  onRecordEvent(phoneId: string, event: RecordEvent): void {
    // Browser simulations are not real calls: keep them off the bus so automations never fire.
    if (event.test || !ALLOWED_EVENTS.has(event.type)) return;
    const before = this.lineState(phoneId);
    const lineNumber = this.lines.get(phoneId)?.get(event.interactionId)?.number ?? null;
    this.trackLine(phoneId, event);
    const state = this.lineState(phoneId);
    const client = this.client;
    if (!client || !this.topicPrefix) return;

    const details = event.details;
    const payload = {
      phoneId,
      interactionId: event.interactionId,
      type: event.type,
      occurredAt: event.occurredAt,
      untrusted: true,
      contact: text(details.contact),
      number: eventNumber(details) ?? lineNumber,
      direction: text(details.direction),
      details,
    };
    this.publish(client, `${this.phoneBase(phoneId)}/${event.type.replace('.', '/')}`, JSON.stringify(payload), false);
    if (state !== before) this.publish(client, this.stateTopic(phoneId), state, true);
  }

  stop(): void {
    this.closeClient();
    this.configKey = null;
    this.topicPrefix = '';
    this.lastConnectionFailureAt = null;
    this.connectionFailureActive = false;
  }

  /** Records what a call event does to its own call on the phone. */
  private trackLine(phoneId: string, event: RecordEvent): void {
    const calls = this.lines.get(phoneId) ?? new Map<string, LineCall>();
    this.lines.set(phoneId, calls);
    const id = event.interactionId;
    switch (event.type) {
      case 'call.started':
        calls.set(id, { state: event.details.direction === 'outbound' ? 'dialing' : 'ringing', number: eventNumber(event.details), since: this.now() });
        break;
      case 'call.answered':
        calls.set(id, { state: 'active', number: calls.get(id)?.number ?? null, since: this.now() });
        break;
      case 'call.ended':
        calls.delete(id);
        break;
    }
  }

  /** The most engaged live call decides the phone's state; unanswered calls that never ended expire. */
  private lineState(phoneId: string): CallState {
    const calls = this.lines.get(phoneId);
    if (!calls) return 'idle';
    let state: CallState = 'idle';
    for (const [id, call] of calls) {
      if (call.state !== 'active' && this.now() - call.since > UNANSWERED_CALL_MAX_MS) { calls.delete(id); continue; }
      if (STATE_RANK[call.state] > STATE_RANK[state]) state = call.state;
    }
    return state;
  }

  private phoneBase(phoneId: string): string {
    return `${this.topicPrefix}/${this.phoneTopics.get(phoneId) ?? phoneId}`;
  }

  private stateTopic(phoneId: string): string {
    return `${this.phoneBase(phoneId)}/call/state`;
  }

  private statusTopic(): string {
    return `${this.topicPrefix}/status`;
  }

  private currentStateTopics(): string[] {
    return [...this.phoneTopics.keys()].map((phoneId) => this.stateTopic(phoneId));
  }

  /**
   * On every (re)connect and phone change: mark Timbre online, clear retained state left on old topics,
   * then overwrite every phone's state, so a crash, restart or rename leaves nothing stale. Clearing comes
   * first so a topic one phone gave up and another took ends with the new owner's state.
   */
  private publishCurrentState(client: MqttClient): void {
    this.publish(client, this.statusTopic(), 'online', true);
    for (const topic of this.staleStateTopics) this.publish(client, topic, '', true);
    this.staleStateTopics.clear();
    for (const phoneId of this.phoneTopics.keys()) {
      this.publish(client, this.stateTopic(phoneId), this.lineState(phoneId), true);
    }
  }

  private publish(client: MqttClient, topic: string, message: string, retain: boolean): void {
    try {
      client.publish(topic, message, { qos: 1, retain }, (error) => {
        if (error) this.log(`MQTT publish failed: ${error.message}`);
      });
    } catch (error) {
      this.log(`MQTT publish failed: ${this.errorMessage(error)}`);
    }
  }

  private closeClient(): void {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      // A clean disconnect suppresses the will, so say offline ourselves before leaving. A client that is
      // not connected is forced closed: a graceful end would wait forever for its queued publishes.
      const connected = client.connected;
      if (connected) this.publish(client, this.statusTopic(), 'offline', true);
      client.end(!connected, {}, (error) => {
        if (error) this.log(`MQTT disconnect failed: ${error.message}`);
      });
    } catch (error) {
      this.log(`MQTT disconnect failed: ${this.errorMessage(error)}`);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private logConnectionFailure(error: unknown): void {
    const now = this.now();
    if (this.lastConnectionFailureAt === null || now - this.lastConnectionFailureAt >= CONNECTION_FAILURE_LOG_INTERVAL_MS) {
      this.log(`MQTT connection failed: ${this.errorMessage(error)}`);
      this.lastConnectionFailureAt = now;
    }
    this.connectionFailureActive = true;
  }

  private logConnectionRestored(): void {
    if (!this.connectionFailureActive) return;
    this.connectionFailureActive = false;
    this.lastConnectionFailureAt = null;
    this.log('MQTT connection restored');
  }
}
