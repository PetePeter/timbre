import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, ConfigStore } from '../src/config/timbre-config.js';
import { Hub, type HubLine } from '../src/hub.js';
import { createServer } from '../src/server/server.js';
import { VoiceCatalogue } from '../src/voice/voice-catalogue.js';
import { VoicePreviewService } from '../src/voice/voice-preview.js';
import { decodeBackup, encodeBackup } from '../src/backup/archive.js';

function fakeLine(): HubLine {
  return {
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    async sendSms() { return { sent: false, reason: 'unused' }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    async sendToSession() { return { sent: true }; }, async hangup() {}, async inbox() { return []; },
    async startCallAgent() { return {}; }, async verifyCaller() { return ''; }, isCallerVerified() { return false; }, isCallHolder() { return false; }, transfer() { return false; },
    enterMessageMode() { return false; }, reportCallOutcome() { return false; },
  };
}

let server: Server | undefined;
let hub: Hub | undefined;
let dir: string | undefined;
let store: ConfigStore | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()));
  server = undefined;
  await hub?.stop();
  hub = undefined;
  store = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.unstubAllEnvs();
});

async function boot() {
  dir = mkdtempSync(path.join(tmpdir(), 'timbre-backup-http-'));
  vi.stubEnv('TIMBRE_HOME', dir);
  store = new ConfigStore(path.join(dir, 'timbre.yaml'));
  const config = defaultConfig();
  config.llms[0].kind === 'api' && (config.llms[0].apiKey = 'live-api-secret');
  config.phones[0].mcpServers = [{ name: 'calendar', url: 'https://mcp.example.test', headers: { Authorization: 'live-mcp-secret' }, allowedTools: ['list'] }];
  store.save(config);
  const catalogue = new VoiceCatalogue(path.join(dir, 'voices'), () => store!.get().customPiperModels, async () => []);
  const preview = new VoicePreviewService(catalogue, { piper: async () => Buffer.alloc(0), sapi: async () => Buffer.alloc(0) });
  hub = new Hub({ store, dataDir: dir, version: 'test', log: () => {}, mcpUrl: () => '', createLine: () => fakeLine() });
  await hub.apply();
  server = createServer({ hub, store, staticDir: dir, voiceRoutes: { catalogue, preview }, log: () => {} });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); resolve(); });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const phoneId = store.get().phones[0].id;
  const phoneToken = (hub as unknown as { slots: Map<string, { token: string }> }).slots.get(phoneId)!.token;
  return { base, phoneId, phoneToken, hub };
}

describe('backup HTTP API', () => {
  it('creates a short-lived one-use download without exposing saved secrets', async () => {
    const { base } = await boot();
    const created = await fetch(`${base}/api/backup/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const ticket = await created.json() as { ticket: string; fileName: string };
    expect(ticket.fileName).toMatch(/^timbre-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const downloaded = await fetch(`${base}/api/backup/export/${ticket.ticket}`);
    expect(downloaded.status).toBe(200);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    expect(bytes.toString('utf8')).not.toContain('live-api-secret');
    expect(bytes.toString('utf8')).not.toContain('live-mcp-secret');
    expect(decodeBackup(bytes).config.llms[0]).toMatchObject({ apiKey: '' });
    expect((await fetch(`${base}/api/backup/export/${ticket.ticket}`)).status).toBe(404);
  });

  it('refuses phone tokens and cross-origin writes on backup routes', async () => {
    const { base, phoneToken } = await boot();
    const phone = await fetch(`${base}/api/backup/export`, {
      method: 'POST', headers: { authorization: `Bearer ${phoneToken}`, 'content-type': 'application/json' }, body: '{}',
    });
    expect(phone.status).toBe(401);
    const csrf = await fetch(`${base}/api/backup/export`, {
      method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}',
    });
    expect(csrf.status).toBe(403);
  });

  it('waits for in-flight API writes before committing a restore', async () => {
    const { base, phoneId, hub: activeHub } = await boot();
    const config = structuredClone(store!.get());
    config.phones[0].name = 'Restored';
    const archive = encodeBackup({ config, contacts: { [phoneId]: [] }, contactPins: {} });
    let releaseApply!: () => void;
    let signalApply!: () => void;
    const applyEntered = new Promise<void>((resolve) => { signalApply = resolve; });
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    const originalApply = activeHub!.apply.bind(activeHub);
    const originalStop = activeHub!.stop.bind(activeHub);
    let stopCalls = 0;
    activeHub!.apply = async () => { signalApply(); await applyGate; await originalApply(); };
    activeHub!.stop = async () => { stopCalls++; await originalStop(); };

    const next = structuredClone(store!.get());
    next.phones[0].name = 'In flight';
    const save = fetch(`${base}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next),
    });
    await applyEntered;
    const restore = fetch(`${base}/api/backup/import`, { method: 'POST', body: archive });
    let lockResponse: Response | undefined;
    const lockDeadline = Date.now() + 3000;
    while (Date.now() < lockDeadline) {
      lockResponse = await fetch(`${base}/api/status`);
      if (lockResponse.status === 409) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(lockResponse?.status).toBe(409);
    expect(stopCalls).toBe(0);
    expect(store!.get().phones[0].name).toBe('In flight');
    releaseApply();
    expect((await save).status).toBe(200);
    expect((await restore).status).toBe(200);
    expect(store!.get().phones[0].name).toBe('Restored');
    expect(stopCalls).toBe(1);
  });

  it('validates before stopping the Hub and restores only managed config, contacts, PINs, and daily events', async () => {
    const { base, phoneId } = await boot();
    const phoneDir = path.join(dir!, 'phones', phoneId);
    mkdirSync(path.join(phoneDir, 'events'), { recursive: true });
    mkdirSync(path.join(phoneDir, 'recordings'), { recursive: true });
    writeFileSync(path.join(phoneDir, 'events', '2026-10-01.jsonl'), 'old event\n');
    writeFileSync(path.join(phoneDir, 'recordings', 'keep.json'), 'existing transcript');

    const config = structuredClone(defaultConfig());
    config.phones[0].id = phoneId;
    config.phones[0].line.persona.tone = 'quiet and direct';
    (config.phones[0].line.voice as unknown as Record<string, unknown>).customPath = 'C:/voices/owner.wav';
    const event = { eventId: 'event-2', interactionId: 'call-2', kind: 'call', type: 'call.started', occurredAt: '2026-10-30T00:00:00.000Z', details: {} };
    const bytes = encodeBackup({
      config,
      contacts: { [phoneId]: [{ id: 'contact-2', name: 'Jordan', numbers: ['+61412345678'], group: 'Family', trusted: true, isUser: false }] },
      records: { [phoneId]: { '2026-10-30.jsonl': `${JSON.stringify(event)}\n` } },
      contactPins: {},
    });
    const response = await fetch(`${base}/api/backup/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes });
    expect(response.status).toBe(200);
    expect(store!.get().phones[0].line.persona.tone).toBe('quiet and direct');
    expect((store!.get().phones[0].line.voice as unknown as Record<string, unknown>).customPath).toBe('C:/voices/owner.wav');
    expect(JSON.parse(readFileSync(path.join(phoneDir, 'contacts.json'), 'utf8'))[0].name).toBe('Jordan');
    expect(existsSync(path.join(phoneDir, 'contact-pins.json'))).toBe(false);
    expect(existsSync(path.join(phoneDir, 'events', '2026-10-01.jsonl'))).toBe(false);
    expect(readFileSync(path.join(phoneDir, 'events', '2026-10-30.jsonl'), 'utf8')).toContain('event-2');
    expect(readFileSync(path.join(phoneDir, 'recordings', 'keep.json'), 'utf8')).toBe('existing transcript');
  });

  it('rejects an incorrect secret passphrase without changing managed files', async () => {
    const { base, phoneId } = await boot();
    const original = readFileSync(path.join(dir!, 'timbre.yaml'), 'utf8');
    const config = structuredClone(store!.get());
    config.phones[0].name = 'Changed';
    const bytes = encodeBackup({ config, contacts: { [phoneId]: [] }, contactPins: {}, includeSecrets: true, passphrase: 'correct-passphrase' });
    const response = await fetch(`${base}/api/backup/import`, {
      method: 'POST', headers: { 'x-timbre-backup-passphrase': 'incorrect-passphrase' }, body: bytes,
    });
    expect(response.status).toBe(400);
    expect(readFileSync(path.join(dir!, 'timbre.yaml'), 'utf8')).toBe(original);
    expect(store!.get().phones[0].name).not.toBe('Changed');
  });
});
