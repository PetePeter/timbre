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

function callState(event: RecordEvent): CallState | null {
  switch (event.type) {
    case 'call.started': return event.details.direction === 'outbound' ? 'dialing' : 'ringing';
    case 'call.answered': return 'active';
    case 'call.ended': return 'idle';
    default: return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export class MqttPublisher {
  private client: MqttClient | null = null;
  private configKey: string | null = null;
  private topicPrefix = '';
  private phoneTopics = new Map<string, string>();
  private lastConnectionFailureAt: number | null = null;
  private connectionFailureActive = false;

  constructor(private readonly log: (message: string) => void, private readonly now: () => number = Date.now) {}

  configure(config: MqttConfig, phones: MqttPhone[] = []): void {
    this.phoneTopics = topicNames(phones);
    const key = JSON.stringify(config);
    if (key === this.configKey) return;
    this.configKey = key;
    this.topicPrefix = config.enabled ? config.topicPrefix : '';
    this.closeClient();
    this.lastConnectionFailureAt = null;
    this.connectionFailureActive = false;

    if (!config.enabled) return;
    try {
      const client = connect(config.url, {
        reconnectPeriod: 1000,
        ...(config.username ? { username: config.username } : {}),
        ...(config.password ? { password: config.password } : {}),
      });
      this.client = client;
      client.on('error', (error) => {
        if (this.client === client) this.logConnectionFailure(error);
      });
      client.on('connect', () => {
        if (this.client === client) this.logConnectionRestored();
      });
    } catch (error) {
      this.logConnectionFailure(error);
    }
  }

  onRecordEvent(phoneId: string, event: RecordEvent): void {
    const client = this.client;
    if (!client || !this.topicPrefix || !ALLOWED_EVENTS.has(event.type)) return;

    const eventName = event.type.slice(event.type.indexOf('.') + 1);
    const details = event.details;
    const payload = {
      phoneId,
      interactionId: event.interactionId,
      type: event.type,
      occurredAt: event.occurredAt,
      ...(event.test ? { test: event.test } : {}),
      untrusted: true,
      contact: text(details.contact),
      number: text(details.from) ?? text(details.to) ?? text(details.number),
      direction: text(details.direction),
      details,
    };
    const base = `${this.topicPrefix}/${this.phoneTopics.get(phoneId) ?? phoneId}`;
    this.publish(client, `${base}/${event.kind}/${eventName}`, JSON.stringify(payload), false);
    const state = callState(event);
    if (state) this.publish(client, `${base}/call/state`, state, true);
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

  stop(): void {
    this.closeClient();
    this.configKey = null;
    this.topicPrefix = '';
    this.lastConnectionFailureAt = null;
    this.connectionFailureActive = false;
  }

  private closeClient(): void {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      client.end(true, {}, (error) => {
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
