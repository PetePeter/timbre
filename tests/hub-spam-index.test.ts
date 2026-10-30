import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addPhone, ConfigStore, defaultConfig } from '../src/config/timbre-config.js';
import { Hub, type HubLine } from '../src/hub.js';
import type { PhoneLineServiceDeps } from '../src/phone/phone-line-service.js';
import { JsonlEventStore } from '../src/records/jsonl-event-store.js';
import type { RecordEvent } from '../src/records/event-types.js';
import { calculateSpamScore, createSpamHistoryIndex, readSpamHistoryByNumber } from '../src/phone/spam-score.js';

const dirs: string[] = [];
const hubs: Hub[] = [];

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function event(type: RecordEvent['type'], interactionId: string, details: Record<string, unknown>, occurredAt = new Date().toISOString()): RecordEvent {
  return {
    eventId: `${interactionId}-${type}`,
    interactionId,
    kind: 'call',
    type,
    occurredAt,
    details,
  };
}

function fakeLine(): HubLine {
  return {
    sendToSession: async () => ({ sent: true }),
    hangup: async () => {},
    inbox: async () => [],
    startCallAgent: async () => ({}),
    verifyCaller: async () => '',
    isCallerVerified: () => false,
    transfer: async () => false,
    enterMessageMode: () => false,
    reportCallOutcome: () => false,
    isCallHolder: () => false,
    apply: async () => {},
    stop: async () => {},
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    restart: async () => {},
    testSms: async () => ({}),
    sendSms: async () => ({ sent: false, reason: 'unused' }),
  };
}

describe('Hub spam history index', () => {
  it('loads phone history once, keys it by normalized number, and indexes appended call outcomes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-spam-index-'));
    dirs.push(dir);
    const config = addPhone(defaultConfig(), 'Home');
    const phoneId = config.phones[0].id;
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    store.save(config);
    const eventStore = new JsonlEventStore(dir);
    eventStore.append(phoneId, event('call.started', 'old-call', { direction: 'inbound', from: '0400 000 000' }));
    eventStore.append(phoneId, event('call.outcome', 'old-call', { outcome: 'spam', source: 'agent' }));
    eventStore.append(phoneId, event('call.started', 'other-call', { direction: 'inbound', from: '+61411111111' }));
    const readEvents = vi.spyOn(JsonlEventStore.prototype, 'readEvents');

    let lineDeps!: PhoneLineServiceDeps;
    const hub = new Hub({
      store, dataDir: dir, version: 'test', log: () => {}, mcpUrl: () => '',
      createLine: (deps) => { if (deps.phoneId === phoneId) lineDeps = deps; return fakeLine(); },
    });
    hubs.push(hub);
    await hub.apply();

    const read = lineDeps.readSpamHistory;
    expect(read).toBeTypeOf('function');
    expect(read?.('+61400000000')).toHaveLength(2);
    expect(read?.('+61411111111')).toHaveLength(1);
    expect(read?.('+61422222222')).toEqual([]);
    expect(calculateSpamScore('+61400000000', read?.('+61400000000') ?? []).spamVerdicts).toBe(1);
    expect(readEvents).toHaveBeenCalledTimes(1);

    lineDeps.recordEvent?.(event('call.started', 'new-call', { direction: 'inbound', from: '+61400000000' }));
    lineDeps.recordEvent?.(event('call.outcome', 'new-call', { outcome: 'spam', source: 'agent' }));

    expect(read?.('+61400000000')).toHaveLength(4);
    expect(calculateSpamScore('+61400000000', read?.('+61400000000') ?? []).autoBlock).toBe(true);
    expect(readEvents).toHaveBeenCalledTimes(1);
  });

  it('keeps only the 90-day window', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-spam-index-'));
    dirs.push(dir);
    const config = addPhone(defaultConfig(), 'Home');
    const phoneId = config.phones[0].id;
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    store.save(config);
    const eventStore = new JsonlEventStore(dir);
    const old = new Date(Date.now() - 91 * 24 * 60 * 60_000).toISOString();
    eventStore.append(phoneId, event('call.started', 'old-call', { direction: 'inbound', from: '+61400000000' }, old));
    eventStore.append(phoneId, event('call.outcome', 'old-call', { outcome: 'spam', source: 'agent' }, old));
    eventStore.append(phoneId, event('call.started', 'recent-call', { direction: 'inbound', from: '+61400000000' }));

    let lineDeps!: PhoneLineServiceDeps;
    const hub = new Hub({
      store, dataDir: dir, version: 'test', log: () => {}, mcpUrl: () => '',
      createLine: (deps) => { if (deps.phoneId === phoneId) lineDeps = deps; return fakeLine(); },
    });
    hubs.push(hub);
    await hub.apply();

    expect(lineDeps.readSpamHistory?.('+61400000000')).toHaveLength(1);
    expect(calculateSpamScore('+61400000000', lineDeps.readSpamHistory?.('+61400000000') ?? []).spamVerdicts).toBe(0);
  });

  it('keeps the latest 50 events per number and prunes on insert and read', () => {
    const now = Date.parse('2026-10-30T00:00:00.000Z');
    const number = '+61400000000';
    const recent = Array.from({ length: 70 }, (_, index) => event(
      'call.started', `recent-${index}`, { direction: 'inbound', from: number },
      new Date(now - (69 - index) * 60_000).toISOString(),
    ));
    const stale = event('call.started', 'stale', { direction: 'inbound', from: number },
      new Date(now - 91 * 24 * 60 * 60_000).toISOString());

    const index = createSpamHistoryIndex('61', [...recent, stale], now);
    const retained = index.byNumber.get(number) ?? [];
    expect(retained).toHaveLength(50);
    expect(retained.map((item) => item.interactionId))
      .toEqual(Array.from({ length: 50 }, (_, offset) => `recent-${offset + 20}`));
    expect(index.numberByInteraction.size).toBe(50);
    expect(index.numberByInteraction.has('recent-19')).toBe(false);
    expect(index.numberByInteraction.has('stale')).toBe(false);

    expect(readSpamHistoryByNumber(index, number, now)).toHaveLength(50);
    expect(readSpamHistoryByNumber(index, number, now + 91 * 24 * 60 * 60_000)).toEqual([]);
    expect(index.byNumber.has(number)).toBe(false);
    expect(index.numberByInteraction.size).toBe(0);
  });

  it('caps the phone index at 20,000 caller numbers', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-spam-index-'));
    dirs.push(dir);
    const config = addPhone(defaultConfig(), 'Home');
    const phoneId = config.phones[0].id;
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    store.save(config);
    const events = Array.from({ length: 20_001 }, (_, index) => event(
      'call.started', `call-${index}`, { direction: 'inbound', from: `+1999${String(index).padStart(8, '0')}` },
    ));
    vi.spyOn(JsonlEventStore.prototype, 'readEvents').mockReturnValue(events);

    let lineDeps!: PhoneLineServiceDeps;
    const hub = new Hub({
      store, dataDir: dir, version: 'test', log: () => {}, mcpUrl: () => '',
      createLine: (deps) => { if (deps.phoneId === phoneId) lineDeps = deps; return fakeLine(); },
    });
    hubs.push(hub);
    await hub.apply();

    expect(lineDeps.readSpamHistory?.('+199900000000')).toEqual([]);
    expect(lineDeps.readSpamHistory?.('+199900000001')).toHaveLength(1);
  });
});
