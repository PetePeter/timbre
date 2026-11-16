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

async function startBroker(port?: number): Promise<string> {
  const broker = await Aedes.createBroker();
  const server = createNetServer(broker.handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  brokers.push({ broker, server });
  return `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for MQTT state.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
        contact: 'Shop', number: null, direction: null,
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

  it('throttles connection failures while the broker is down and logs one recovery', async () => {
    const port = await reservePort();
    const logs: string[] = [];
    let now = 0;
    const publisher = new MqttPublisher((message) => logs.push(message), () => now);
    publisher.configure(config(`mqtt://127.0.0.1:${port}`));

    try {
      await waitFor(() => logs.some((message) => message.startsWith('MQTT connection failed:')));
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(logs.filter((message) => message.startsWith('MQTT connection failed:'))).toHaveLength(1);

      now += 60_000;
      await waitFor(() => logs.filter((message) => message.startsWith('MQTT connection failed:')).length === 2);
      await startBroker(port);
      await waitFor(() => logs.includes('MQTT connection restored'));
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(logs.filter((message) => message === 'MQTT connection restored')).toHaveLength(1);
    } finally {
      publisher.stop();
    }
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

  it('names topics after the phone, falling back to the id for blank or duplicate names', async () => {
    const url = await startBroker();
    const subscriber = await subscribe(url);
    const topics: string[] = [];
    subscriber.on('message', (topic) => topics.push(topic));
    const publisher = new MqttPublisher(() => {});
    publisher.configure(config(url), [
      { id: 'phone-1', name: 'Oscar Pixel 9!' }, { id: 'phone-2', name: 'Twin' }, { id: 'phone-3', name: 'twin' }, { id: 'phone-4', name: '  ' },
    ]);
    for (const id of ['phone-1', 'phone-2', 'phone-3', 'phone-4']) publisher.onRecordEvent(id, event('sms.sent', 'sms'));
    await waitFor(() => topics.length === 4);

    expect(topics.sort()).toEqual(['timbre/oscar-pixel-9/sms/sent', 'timbre/phone-2/sms/sent', 'timbre/phone-3/sms/sent', 'timbre/phone-4/sms/sent']);
    publisher.stop();
  });

  it('lifts number, contact and direction to the top of the payload', async () => {
    const url = await startBroker();
    const subscriber = await subscribe(url);
    const publisher = new MqttPublisher(() => {});
    publisher.configure(config(url));
    const inbound = nextMessage(subscriber);
    publisher.onRecordEvent('phone-1', { ...event('sms.received', 'sms'), details: { contact: 'Oscar', from: '+61400000000', direction: 'inbound' } });
    await expect(inbound).resolves.toMatchObject({ payload: { contact: 'Oscar', number: '+61400000000', direction: 'inbound' } });

    const outbound = nextMessage(subscriber);
    publisher.onRecordEvent('phone-1', { ...event('sms.sent', 'sms'), details: { to: '+61411111111', direction: 'outbound' } });
    await expect(outbound).resolves.toMatchObject({ payload: { contact: null, number: '+61411111111', direction: 'outbound' } });
    publisher.stop();
  });

  it('keeps a retained call state that a late subscriber sees', async () => {
    const url = await startBroker();
    const publisher = new MqttPublisher(() => {});
    publisher.configure(config(url), [{ id: 'phone-1', name: 'Home' }]);
    const stateAfter = async (type: RecordEvent['type'], details: Record<string, unknown> = {}) => {
      publisher.onRecordEvent('phone-1', { ...event(type), details });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const late = connect(url, { reconnectPeriod: 0 });
      clients.push(late);
      const message = new Promise<{ topic: string; payload: string; retain: boolean }>((resolve) => {
        late.on('message', (topic, payload, packet) => resolve({ topic, payload: payload.toString(), retain: packet.retain }));
      });
      late.on('connect', () => late.subscribe('timbre/home/call/state'));
      return message;
    };

    await expect(stateAfter('call.started', { direction: 'inbound' })).resolves.toEqual({ topic: 'timbre/home/call/state', payload: 'ringing', retain: true });
    await expect(stateAfter('call.answered')).resolves.toMatchObject({ payload: 'active' });
    await expect(stateAfter('call.ended')).resolves.toMatchObject({ payload: 'idle' });
    await expect(stateAfter('call.started', { direction: 'outbound' })).resolves.toMatchObject({ payload: 'dialing' });
    publisher.stop();
  });
});
