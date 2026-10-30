import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
});

function fakeWav(): Buffer {
  const data = Buffer.from([1, 2, 3, 4]);
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(8_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(data.length, 40); data.copy(wav, 44);
  return wav;
}

function fakeLine(): HubLine {
  return {
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    async sendSms() { return { sent: false, reason: 'unused' }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    async sendToSession() { return { sent: true }; }, async hangup() {}, async inbox() { return []; },
    async startCallAgent() { return {}; }, async verifyCaller() { return ''; }, isCallerVerified() { return false; }, isCallHolder() { return false; }, transfer() { return false; }, enterMessageMode() { return false; }, reportCallOutcome() { return false; },
  };
}

async function boot() {
  dir = mkdtempSync(path.join(tmpdir(), 'timbre-recordings-api-'));
  const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
  store.save(addPhone(store.get(), 'Work'));
  const phoneIds = store.get().phones.map((phone) => phone.id);
  const interactionId = 'call-123';
  const pendingId = 'call-pending';
  const event = (id: string): RecordEvent => ({
    eventId: `event-${id}`, interactionId: id, kind: 'call', type: 'call.started',
    occurredAt: '2026-10-29T14:00:00.000Z', details: { contact: 'Me', direction: 'inbound', action: 'answered' },
  });
  hub = new Hub({
    store, dataDir: dir, version: 'test', log: () => {}, mcpUrl: () => '',
    createLine: (deps) => {
      const phoneId = deps.getOperatorId()!;
      if (phoneId === phoneIds[0]) {
        deps.recordEvent?.(event(interactionId));
        deps.recordEvent?.(event(pendingId));
        mkdirSync(deps.recordingsDir, { recursive: true });
        // Fake telefony's finalized WAV output at the configured per-phone path.
        writeFileSync(path.join(deps.recordingsDir, `${interactionId}.wav`), fakeWav());
        writeFileSync(path.join(deps.recordingsDir, `${pendingId}.wav.part`), fakeWav());
        writeFileSync(path.join(deps.recordingsDir, `${interactionId}.json`), JSON.stringify({
          date: '2026-10-29T14:00:00.000Z', contact: 'Me', role: 'owner', direction: 'inbound', durationS: 2,
          handledBy: [], utterances: [{ speaker: 'remote', text: 'hello', startMs: 0 }], summary: 'Caller asked about dinner.',
        }));
      }
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
  return { base, phoneIds, interactionId, tokenA: slots.get(phoneIds[0])!.token, tokenB: slots.get(phoneIds[1])!.token };
}

describe('recordings HTTP API', () => {
  it('serves a fake telefony WAV by call event id and supports byte ranges', async () => {
    const { base, phoneIds, interactionId } = await boot();
    const root = `${base}/api/phones/${phoneIds[0]}/recordings/${interactionId}`;
    const meta = await fetch(root);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toEqual({
      transcript: {
        date: '2026-10-29T14:00:00.000Z', contact: 'Me', role: 'owner', direction: 'inbound', durationS: 2,
        handledBy: [], utterances: [{ speaker: 'remote', text: 'hello', startMs: 0 }],
      },
      summary: 'Caller asked about dinner.',
      audioAvailable: true,
    });

    const range = await fetch(`${root}/audio`, { headers: { range: 'bytes=0-11' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('accept-ranges')).toBe('bytes');
    expect(range.headers.get('content-range')).toBe('bytes 0-11/48');
    expect(Buffer.from(await range.arrayBuffer())).toEqual(fakeWav().subarray(0, 12));

    const shortSuffix = await fetch(root + '/audio', { headers: { range: 'bytes=-8' } });
    expect(shortSuffix.status).toBe(206);
    expect(shortSuffix.headers.get('content-range')).toBe('bytes 40-47/48');
    expect(Buffer.from(await shortSuffix.arrayBuffer())).toEqual(fakeWav().subarray(40, 48));

    const longSuffix = await fetch(root + '/audio', { headers: { range: 'bytes=-100' } });
    expect(longSuffix.status).toBe(206);
    expect(longSuffix.headers.get('content-range')).toBe('bytes 0-47/48');
    expect(Buffer.from(await longSuffix.arrayBuffer())).toEqual(fakeWav());

    const pending = `${base}/api/phones/${phoneIds[0]}/recordings/call-pending`;
    expect(await (await fetch(pending)).json()).toEqual({ transcript: null, summary: null, audioAvailable: false });
    expect((await fetch(`${pending}/audio`)).status).toBe(404);
  });

  it('keeps recordings isolated to the phone bearer token and rejects unsatisfiable ranges', async () => {
    const { base, phoneIds, interactionId, tokenA, tokenB } = await boot();
    const target = `${base}/api/phones/${phoneIds[0]}/recordings/${interactionId}/audio`;
    expect((await fetch(target, { headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(200);
    expect((await fetch(target, { headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(401);

    const invalid = await fetch(target, { headers: { range: 'bytes=48-' } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe('bytes */48');
  });
});
