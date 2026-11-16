import { connect, type MqttClient } from 'mqtt';
import type { MqttConfig } from '../config/timbre-config.js';
import type { RecordEvent } from '../records/event-types.js';

const ALLOWED_EVENTS = new Set<RecordEvent['type']>([
  'call.started', 'call.answered', 'call.ended', 'call.outcome', 'call.transferred',
  'call.agent_reported', 'call.agent_question', 'conference.added', 'sms.received', 'sms.sent',
]);

export class MqttPublisher {
  private client: MqttClient | null = null;
  private configKey: string | null = null;
  private topicPrefix = '';

  constructor(private readonly log: (message: string) => void) {}

  configure(config: MqttConfig): void {
    const key = JSON.stringify(config);
    if (key === this.configKey) return;
    this.configKey = key;
    this.topicPrefix = config.enabled ? config.topicPrefix : '';
    this.closeClient();

    if (!config.enabled) return;
    try {
      const client = connect(config.url, {
        reconnectPeriod: 1000,
        ...(config.username ? { username: config.username } : {}),
        ...(config.password ? { password: config.password } : {}),
      });
      client.on('error', (error) => this.log(`MQTT connection failed: ${error.message}`));
      this.client = client;
    } catch (error) {
      this.log(`MQTT connection failed: ${this.errorMessage(error)}`);
    }
  }

  onRecordEvent(phoneId: string, event: RecordEvent): void {
    const client = this.client;
    if (!client || !this.topicPrefix || !ALLOWED_EVENTS.has(event.type)) return;

    const eventName = event.type.slice(event.type.indexOf('.') + 1);
    const payload = {
      phoneId,
      interactionId: event.interactionId,
      type: event.type,
      occurredAt: event.occurredAt,
      ...(event.test ? { test: event.test } : {}),
      untrusted: true,
      details: event.details,
    };
    try {
      client.publish(`${this.topicPrefix}/${phoneId}/${event.kind}/${eventName}`, JSON.stringify(payload), { qos: 1, retain: false }, (error) => {
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
}
