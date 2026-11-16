import { createServer as createNetServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Aedes } from 'aedes';
import { connect, type MqttClient } from 'mqtt';
import { afterEach, describe, expect, it } from 'vitest';
import type { MqttConfig } from '../src/config/timbre-config.js';
import { MqttPublisher } from '../src/notify/mqtt-publisher.js';
import type { RecordEvent } from '../src/records/event-types.js';

const brokers: Array<{ broker: Awaited<ReturnType<typeof Aedes.createBroker>>; server: Server }> = [];
const clients: MqttClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
  }
  for (const { broker, server } of brokers.splice(0)) {
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startBroker(): Promise<string> {
  const broker = await Aedes.createBroker();
  const server = createNetServer(broker.handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  brokers.push({ broker, server });
  return `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function subscribe(url: string): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = connect(url, { reconnectPeriod: 0 });
    clients.push(client);
    client.once('error', reject);
    client.once('connect', () => {
      client.subscribe('#', { qos: 1 }, (error) => {
        if (error) reject(error);
        else resolve(client);
      });
    });
  });
}

function nextMessage(client: MqttClient): Promise<{ topic: string; payload: Record<string, unknown>; qos: number; retain: boolean }> {
  return new Promise((resolve) => {
    client.once('message', (topic, payload, packet) => resolve({
      topic,
      payload: JSON.parse(payload.toString()) as Record<string, unknown>,
      qos: packet.qos,
      retain: packet.retain,
    }));
  });
}

function event(type: RecordEvent['type'], kind: RecordEvent['kind'] = 'call'): RecordEvent {
  return {
    eventId: 'event-1', interactionId: 'interaction-1', kind, type,
    occurredAt: '2026-11-16T03:00:00.000Z', test: true,
    details: { contact: 'Shop', action: 'call ended' },
  };
}

function config(url: string, topicPrefix = 'timbre'): MqttConfig {
  return { enabled: true, url, username: '', password: '', topicPrefix };
}

describe('MQTT record publisher', () => {
  it('publishes allowlisted record events with the expected topic and payload at QoS 1 without retain', async () => {
    const url = await startBroker();
    const subscriber = await subscribe(url);
    const message = nextMessage(subscriber);
    const publisher = new MqttPublisher(() => {});
    publisher.configure(config(url));
    publisher.onRecordEvent('phone-1', event('call.ended'));

    await expect(message).resolves.toEqual({
      topic: 'timbre/phone-1/call/ended',
      payload: {
        phoneId: 'phone-1', interactionId: 'interaction-1', type: 'call.ended',
        occurredAt: '2026-11-16T03:00:00.000Z', test: true, untrusted: true,
        details: { contact: 'Shop', action: 'call ended' },
      },
      qos: 1,
      retain: false,
    });
    publisher.stop();
  });

  it('does not publish non-allowlisted record events', async () => {
    const url = await startBroker();
    const subscriber = await subscribe(url);
    const messages: string[] = [];
    subscriber.on('message', (topic) => messages.push(topic));
    const publisher = new MqttPublisher(() => {});
    publisher.configure(config(url));
    publisher.onRecordEvent('phone-1', event('policy.evaluated', 'system'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toEqual([]);
    publisher.stop();
  });

  it('does not connect or publish when disabled', async () => {
    const url = await startBroker();
    const subscriber = await subscribe(url);
    const messages: string[] = [];
    subscriber.on('message', (topic) => messages.push(topic));
    const publisher = new MqttPublisher(() => {});
    publisher.configure({ ...config(url), enabled: false });
    publisher.onRecordEvent('phone-1', event('call.ended'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toEqual([]);
    expect(brokers[0]!.broker.connectedClients).toBe(1);
    publisher.stop();
  });

  it('logs invalid broker URLs without throwing', async () => {
    const logs: string[] = [];
    const publisher = new MqttPublisher((message) => logs.push(message));

    expect(() => publisher.configure(config('ftp://invalid.example'))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logs.length).toBeGreaterThan(0);
    publisher.stop();
  });

  it('uses a new topic prefix after reconfiguration', async () => {
    const url = await startBroker();
    const subscriber = await subscribe(url);
    const publisher = new MqttPublisher(() => {});
    publisher.configure(config(url, 'first'));
    const first = nextMessage(subscriber);
    publisher.onRecordEvent('phone-1', event('sms.sent', 'sms'));
    await expect(first).resolves.toMatchObject({ topic: 'first/phone-1/sms/sent' });

    publisher.configure(config(url, 'second'));
    const second = nextMessage(subscriber);
    publisher.onRecordEvent('phone-1', event('sms.sent', 'sms'));
    await expect(second).resolves.toMatchObject({ topic: 'second/phone-1/sms/sent' });
    publisher.stop();
  });
});
