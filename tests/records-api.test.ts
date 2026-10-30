import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addPhone, ConfigStore } from '../src/config/timbre-config.js';
import { Hub, type HubLine } from '../src/hub.js';
import type { RecordEvent } from '../src/records/event-types.js';
import { createServer } from '../src/server/server.js';

let server: Server | undefined;
let hub: Hub | undefined;
let dir: string | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()));
  server = undefined;
  await hub?.stop();
  hub = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.unstubAllEnvs();
});

function fakeLine(): HubLine {
  return {
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    async sendSms() { return { sent: false, reason: 'unused' }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    async sendToSession() { return { sent: true }; }, async hangup() {}, async inbox() { return []; },
    async startCallAgent() { return {}; }, async verifyCaller() { return ''; }, isCallerVerified() { return false; }, isCallHolder() { return false; }, transfer() { return false; }, enterMessageMode() { return false; }, reportCallOutcome() { return false; },
  };
}

async function boot(seedInsights = false) {
  dir = mkdtempSync(path.join(tmpdir(), 'timbre-record-api-'));
  vi.stubEnv('TIMBRE_HOME', dir);
  const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
  store.save(addPhone(store.get(), 'Work'));
  const phoneIds = store.get().phones.map((phone) => phone.id);
  const event = (eventId: string, phoneId: string, interactionId: string, at: string): RecordEvent => ({
    eventId, interactionId, kind: 'call', type: 'call.started', occurredAt: at,
    details: { contact: phoneId, direction: 'inbound', action: 'answered' },
  });
  hub = new Hub({
    store, dataDir: dir, version: 'test', log: () => {}, mcpUrl: () => '',
    createLine: (deps) => {
      const phoneId = deps.getOperatorId()!;
      deps.recordEvent?.(event(`event-${phoneId}`, phoneId, `call-${phoneId}`, '2026-10-29T14:00:00.000Z'));
      if (phoneId === phoneIds[0]) deps.recordEvent?.(event(`later-${phoneId}`, phoneId, `later-${phoneId}`, '2026-10-29T15:00:00.000Z'));
      if (seedInsights) {
        const interactionId = `insights-${phoneId}`;
        const outcome = phoneId === phoneIds[0] ? 'spam' : 'left_message';
        const record = (eventId: string, type: RecordEvent['type'], occurredAt: string, details: Record<string, unknown> = {}) => {
          deps.recordEvent?.({ eventId, interactionId, kind: 'call', type, occurredAt, details });
        };
        record(`insights-start-${phoneId}`, 'call.started', '2026-10-29T10:00:00.000Z');
        record(`insights-end-${phoneId}`, 'call.ended', '2026-10-29T10:02:00.000Z', { durationSeconds: 120 });
        record(`insights-outcome-${phoneId}`, 'call.outcome', '2026-10-30T10:00:00.000Z', { outcome, source: 'agent' });
        if (phoneId === phoneIds[0]) {
          record(`insights-transfer-${phoneId}`, 'call.transferred', '2026-10-29T10:01:00.000Z');
          record(`insights-conference-${phoneId}`, 'conference.added', '2026-10-29T10:01:30.000Z');
        }
      }
      deps.recordEvent?.({
        eventId: `sms-${phoneId}`, interactionId: `sms-${phoneId}`, kind: 'sms', type: 'sms.received',
        occurredAt: '2026-10-28T16:00:00.000Z', details: { text: `needle for ${phoneId}`, contact: phoneId },
      });
      return fakeLine();
    },
  });
  await hub.apply();
  const slots = (hub as unknown as { slots: Map<string, { token: string }> }).slots;
  server = createServer({ hub, store, staticDir: dir, log: () => {} });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); resolve(); });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, phoneIds, tokenA: slots.get(phoneIds[0])!.token, tokenB: slots.get(phoneIds[1])!.token };
}

describe('records HTTP API', () => {
  it('filters local-day UTC instants, pages records, and keeps each phone isolated', async () => {
    const { base, phoneIds, tokenA, tokenB } = await boot();
    const [phoneA, phoneB] = phoneIds;
    const from = encodeURIComponent('2026-10-29T13:00:00.000Z');
    const to = encodeURIComponent('2026-10-30T13:00:00.000Z');
    const url = (phone: string) => `${base}/api/phones/${phone}/records?from=${from}&to=${to}&limit=1`;

    const page = await (await fetch(url(phoneA))).json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe(`later-${phoneA}`);
    expect(page.nextCursor).toBeTruthy();
    const older = await (await fetch(`${url(phoneA)}&cursor=${encodeURIComponent(page.nextCursor)}`)).json();
    expect(older.items.map((item: { id: string }) => item.id)).toEqual([`call-${phoneA}`]);
    expect(older.nextCursor).toBeNull();
    const other = await (await fetch(url(phoneB))).json();
    expect(other.items[0].id).toBe(`call-${phoneB}`);
    const detail = await fetch(`${base}/api/phones/${phoneA}/records/call-${phoneA}`);
    expect((await detail.json()).id).toBe(`call-${phoneA}`);
    expect((await fetch(`${base}/api/phones/${phoneB}/records`, { headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/phones/${phoneB}/records`, { headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(200);
  });

  it('returns complete phone-scoped Insights while keeping outcomes after the range attached to call starts', async () => {
    const { base, phoneIds, tokenA } = await boot(true);
    const [phoneA, phoneB] = phoneIds;
    const query = '?from=2026-10-29T09%3A00%3A00.000Z&to=2026-10-29T11%3A00%3A00.000Z';
    const a = await fetch(`${base}/api/phones/${phoneA}/insights${query}`);
    const resultA = await a.json();

    expect(a.status).toBe(200);
    expect(resultA.totalCalls).toBe(1);
    expect(resultA.outcomes.find((item: { outcome: string }) => item.outcome === 'spam')?.count).toBe(1);
    expect(resultA.handovers).toEqual({ attempts: 1, successes: 1, rate: 1 });
    expect((await fetch(`${base}/api/phones/${phoneB}/insights${query}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    })).status).toBe(401);
    const b = await fetch(`${base}/api/phones/${phoneB}/insights${query}`);
    const resultB = await b.json();
    expect(b.status).toBe(200);
    expect(resultB.outcomes.find((item: { outcome: string }) => item.outcome === 'left_message')?.count).toBe(1);
    expect(resultB.outcomes.find((item: { outcome: string }) => item.outcome === 'spam')?.count).toBe(0);
  });

  it('searches retained message text and enforces the phone token boundary', async () => {
    const { base, phoneIds, tokenA, tokenB } = await boot();
    const [phoneA, phoneB] = phoneIds;
    const url = (phone: string) => `${base}/api/phones/${phone}/search?q=needle`;
    const readySearch = async (phone: string, token: string) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = await fetch(url(phone), { headers: { authorization: `Bearer ${token}` } });
        const result = await response.json();
        if (result.status === 'ready') return { response, result };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('search index did not finish warming');
    };

    expect((await fetch(url(phoneB), { headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(401);
    const { response, result } = await readySearch(phoneA, tokenA);
    expect(response.status).toBe(200);
    expect(result.items.map((item: { id: string }) => item.id)).toEqual([`sms-${phoneA}`]);
    expect(result.items[0].snippet).toContain(`needle for ${phoneA}`);

    const { result: other } = await readySearch(phoneB, tokenB);
    expect(other.items.map((item: { id: string }) => item.id)).toEqual([`sms-${phoneB}`]);
  });
});
