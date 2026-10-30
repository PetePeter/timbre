import { mkdtempSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addPhone, ConfigStore } from '../src/config/timbre-config.js';
import { AppTokenStore } from '../src/config/app-token-store.js';
import { Hub, type HubLine, type LiveAudioEvent, type LiveCallEvent, type LiveCallSnapshot } from '../src/hub.js';
import { authorize, createServer, isLoopback } from '../src/server/server.js';
import { WebServerRuntime } from '../src/server/web-server-runtime.js';
import { VoiceCatalogue } from '../src/voice/voice-catalogue.js';
import { VoicePreviewService } from '../src/voice/voice-preview.js';

interface LiveCallFake {
  eventOpens: number;
  eventCloses: number;
  audioOpens: number;
  audioCloses: number;
  takeovers: number;
  eventListener?: (event: LiveCallEvent) => void;
  audioListener?: (event: LiveAudioEvent) => void;
  snapshot: LiveCallSnapshot;
}

function fakeLiveCall(): LiveCallFake {
  return {
    eventOpens: 0, eventCloses: 0, audioOpens: 0, audioCloses: 0, takeovers: 0,
    snapshot: { callId: 'call-1', label: 'Caller', state: 'active', utterances: [] },
  };
}

/** A phone line with no telefony behind it; records what was sent. */
function fakeLine(sent: string[], live: LiveCallFake): HubLine {
  let streamListener: ((event: { type: string; [key: string]: unknown }) => void) | null = null;
  let streamOpen = false;
  return {
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    async sendSms() { return { sent: false, reason: 'unused' }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    async sendToSession(m) { sent.push(m.text); return { sent: true }; },
    async hangup() {}, async inbox() { return []; }, async startCallAgent() { return {}; }, async verifyCaller() { return ''; }, isCallerVerified() { return false; },
    isCallHolder() { return false; }, transfer() { return false; }, enterMessageMode() { return false; }, reportCallOutcome() { return false; },
    startTestCall(callerNumber: string) { return { callId: 'test-call', callerNumber }; },
    openTestCallStream(callId: string, listener: (event: { type: string; [key: string]: unknown }) => void) {
      if (callId !== 'test-call') throw new Error('test call not found');
      if (streamOpen) throw new Error('one stream per test call');
      streamOpen = true;
      streamListener = listener;
      listener({ type: 'state', state: 'ringing' });
      return () => { streamListener = null; streamOpen = false; };
    },
    submitTestCallUtterance(callId: string, text: string) {
      if (callId !== 'test-call' || !streamListener) throw new Error('test call is not streaming');
      streamListener({ type: 'message', speaker: 'caller', text });
    },
    endTestCall(callId: string) {
      if (callId !== 'test-call') throw new Error('test call not found');
      streamListener?.({ type: 'state', state: 'ended' });
    },
    openLiveCallStream(callId: string, listener: (event: LiveCallEvent) => void) {
      if (callId !== live.snapshot.callId) throw new Error('live call not found');
      live.eventOpens++;
      live.eventListener = listener;
      return {
        snapshot: live.snapshot,
        close() { live.eventCloses++; live.eventListener = undefined; },
      };
    },
    async openLiveAudioStream(callId: string, listener: (event: LiveAudioEvent) => void) {
      if (callId !== live.snapshot.callId) throw new Error('live call not found');
      live.audioOpens++;
      live.audioListener = listener;
      return () => { live.audioCloses++; live.audioListener = undefined; };
    },
    async takeoverLiveCall(callId: string) {
      if (callId !== live.snapshot.callId) throw new Error('live call not found');
      live.takeovers++;
    },
  } as unknown as HubLine;
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

async function boot(port = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), 'timbre-srv-'));
  const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
  store.save({ ...store.get(), web: { ...store.get().web, port } });
  const catalogue = new VoiceCatalogue(path.join(dir, 'voices'), () => store.get().customPiperModels, async () => []);
  const preview = new VoicePreviewService(catalogue, { piper: async () => Buffer.alloc(0), sapi: async () => Buffer.alloc(0) });
  const sent: string[] = [];
  const live = fakeLiveCall();
  let base = '';
  const hub = new Hub({ store, dataDir: dir, version: 't', log: () => {}, mcpUrl: (id) => `${base}/mcp/${id}`, createLine: () => fakeLine(sent, live) });
  await hub.apply();
  let runtime!: WebServerRuntime;
  const server = createServer({
    hub, store, staticDir: path.join(dir, 'none'), log: () => {},
    dataDir: dir,
    voiceRoutes: { catalogue, preview },
    onWebConfigChange: () => runtime.rebind(),
  });
  runtime = new WebServerRuntime(server, store);
  await runtime.start();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => runtime.stop();
  return { base, dir, hub, live, store, sent, server, runtime };
}

function addressOf(server: Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return address;
}

async function availablePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = addressOf(server).port;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('timed out waiting for server rebind');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const rpc = (base: string, phoneId: string, token: string, body: object) =>
  fetch(`${base}/mcp/${phoneId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });

describe('isLoopback', () => {
  it('knows IPv4, IPv6 and mapped loopback', () => {
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1'].every(isLoopback)).toBe(true);
    expect(isLoopback('192.168.1.5')).toBe(false);
  });
});

describe('authorize', () => {
  const web = { port: 1, lan: true, token: 'secret-token' };
  it('lets localhost through without a token', () => {
    expect(authorize('127.0.0.1', {}, web)).toBe(true);
  });
  it('needs the token from anywhere else, via bearer or cookie', () => {
    expect(authorize('192.168.1.9', {}, web)).toBe(false);
    expect(authorize('192.168.1.9', { authorization: 'Bearer wrong' }, web)).toBe(false);
    expect(authorize('192.168.1.9', { authorization: 'Bearer secret-token' }, web)).toBe(true);
    expect(authorize('192.168.1.9', { cookie: 'a=1; timbre_token=secret-token' }, web)).toBe(true);
  });
  it('refuses remote callers when LAN access is off, token or not', () => {
    expect(authorize('192.168.1.9', { authorization: 'Bearer secret-token' }, { ...web, lan: false })).toBe(false);
  });
});

describe('web API', () => {
  it('serves status and config to localhost without a token', async () => {
    const { base } = await boot();
    const status = await (await fetch(`${base}/api/status`)).json();
    expect(status.phones).toHaveLength(1);
    expect((await fetch(`${base}/api/config`)).status).toBe(200);
  });

  it('starts, streams, accepts text for, and ends a browser test call', async () => {
    const { base, store } = await boot();
    const phoneId = store.get().phones[0].id;
    const started = await fetch(`${base}/api/phones/${phoneId}/test-call`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callerNumber: '+61491570156' }),
    });
    expect(started.status).toBe(200);
    const { callId } = await started.json() as { callId: string };

    const stream = await fetch(`${base}/api/phones/${phoneId}/test-call/${callId}/events`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"state":"ringing"');
      expect((await fetch(`${base}/api/phones/${phoneId}/test-call/${callId}/events`)).status).toBe(409);

      const utterance = await fetch(`${base}/api/phones/${phoneId}/test-call/${callId}/utterances`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello from the browser.' }),
      });
      expect(utterance.status).toBe(200);
      const ended = await fetch(`${base}/api/phones/${phoneId}/test-call/${callId}`, { method: 'DELETE' });
      expect(ended.status).toBe(200);
    } finally {
      await reader.cancel();
    }
  });

  it('streams the live call snapshot and stops the subscriber on disconnect', async () => {
    const { base, live, store } = await boot();
    const phoneId = store.get().phones[0].id;
    const response = await fetch(`${base}/api/phones/${phoneId}/live-call/events?callId=call-1`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('event: snapshot');
      expect(new TextDecoder().decode(first.value)).toContain('"callId":"call-1"');
      live.eventListener?.({ type: 'utterance', callId: 'call-1', utterance: { speaker: 'remote', text: 'Hello', startMs: 0 } });
      const update = await reader.read();
      expect(new TextDecoder().decode(update.value)).toContain('event: utterance');
      live.eventListener?.({ type: 'state', callId: 'call-1', state: 'ended' });
      const ended = await reader.read();
      expect(new TextDecoder().decode(ended.value)).toContain('event: state');
      await waitUntil(() => live.eventCloses === 1);
    } finally {
      await reader.cancel();
    }
  });

  it('closes authenticated live-call streams when the web token changes', async () => {
    const { base, live, store } = await boot();
    const phoneId = store.get().phones[0].id;
    const response = await fetch(`${base}/api/phones/${phoneId}/live-call/events?callId=call-1`);
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: snapshot');
      const current = store.get();
      const rotated = await fetch(`${base}/api/config`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...current, web: { ...current.web, token: 'rotated-web-token' } }),
      });
      expect(rotated.status).toBe(200);
      expect((await reader.read()).done).toBe(true);
      await waitUntil(() => live.eventCloses === 1);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('starts live audio only on its explicit stream and stops on disconnect', async () => {
    const { base, live, store } = await boot();
    const phoneId = store.get().phones[0].id;
    const response = await fetch(`${base}/api/phones/${phoneId}/live-call/audio?callId=call-1`);
    expect(response.status).toBe(200);
    expect(live.audioOpens).toBe(1);
    const reader = response.body!.getReader();
    try {
      live.audioListener?.({ type: 'frame', frame: {
        callId: 'call-1', sequence: 1, sampleRate: 8000, channels: 2, encoding: 'pcm_s16le', data: Buffer.alloc(640).toString('base64')
      } });
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('event: frame');
      expect(new TextDecoder().decode(first.value)).toContain('"data":"' + Buffer.alloc(640).toString('base64') + '"');
    } finally {
      await reader.cancel();
    }
    await waitUntil(() => live.audioCloses === 1);
  });

  it('closes live audio streams before the web server waits for shutdown', async () => {
    const { base, live, store, runtime } = await boot();
    const phoneId = store.get().phones[0].id;
    const response = await fetch(`${base}/api/phones/${phoneId}/live-call/audio?callId=call-1`);
    expect(response.status).toBe(200);
    expect(live.audioOpens).toBe(1);
    const reader = response.body!.getReader();
    try {
      await runtime.stop();
      expect((await reader.read()).done).toBe(true);
      expect(live.audioCloses).toBe(1);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('rejects phone and app tokens on live audio routes, even on loopback', async () => {
    const { base, dir, hub, live, store } = await boot();
    const phoneId = store.get().phones[0].id;
    const phoneForToken = hub.phoneForToken.bind(hub);
    hub.phoneForToken = (token) => token === 'phone-token' ? phoneId : phoneForToken(token);
    const appToken = new AppTokenStore(path.join(dir, 'app-tokens.json'))
      .create({ name: 'records tool', phoneIds: [phoneId], actions: ['records.read'] }).token;

    for (const token of ['phone-token', appToken]) {
      const response = await fetch(`${base}/api/phones/${phoneId}/live-call/audio?callId=call-1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await response.body?.cancel();
      expect(response.status).toBe(401);
    }
    expect(live.audioOpens).toBe(0);
  });

  it('refuses cross-origin takeover before invoking the phone action', async () => {
    const { base, live, store } = await boot();
    const phoneId = store.get().phones[0].id;
    const response = await fetch(`${base}/api/phones/${phoneId}/live-call/takeover`, {
      method: 'POST',
      headers: { origin: 'https://elsewhere.example', 'content-type': 'application/json' },
      body: JSON.stringify({ callId: 'call-1' }),
    });
    expect(response.status).toBe(403);
    expect(live.takeovers).toBe(0);
  });

  it('rejects cross-origin audio GETs and cross-site live streams', async () => {
    const { base, live, store } = await boot();
    const phoneId = store.get().phones[0].id;
    const audioUrl = `${base}/api/phones/${phoneId}/live-call/audio?callId=call-1`;
    const eventsUrl = `${base}/api/phones/${phoneId}/live-call/events?callId=call-1`;

    for (const [url, headers] of [
      [audioUrl, { origin: 'https://elsewhere.example' }],
      [eventsUrl, { 'sec-fetch-site': 'cross-site' }],
      [audioUrl, { 'sec-fetch-site': 'cross-site' }],
    ] as const) {
      const response = await fetch(url, { headers });
      expect(response.status).toBe(403);
      await response.body?.cancel();
    }

    expect(live.audioOpens).toBe(0);
    expect(live.eventOpens).toBe(0);
  });

  it('serves voice catalogue through the shared API gate and rejects cross-origin preview writes', async () => {
    const { base } = await boot();
    const catalogue = await fetch(`${base}/api/voices`);
    expect(catalogue.status).toBe(200);
    expect(Array.isArray(await catalogue.json())).toBe(true);
    const preview = await fetch(`${base}/api/voices/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ id: 'sapi:Hazel' }),
    });
    expect(preview.status).toBe(403);
  });

  it('PUT /api/config saves the normalized config', async () => {
    const { base, store } = await boot();
    const cfg = store.get();
    const res = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...cfg, phones: [{ ...cfg.phones[0], name: 'Desk' }] }) });
    expect(res.status).toBe(200);
    expect(store.get().phones[0].name).toBe('Desk');
  });

  it('masks MCP header and environment secrets in config responses and preserves masked values on save', async () => {
    const { base, store } = await boot();
    const cfg = store.get();
    const phone = cfg.phones[0];
    store.save({
      ...cfg,
      phones: [{ ...phone, mcpServers: [
        {
          name: 'private-http', url: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer saved-header-secret' }, allowedTools: ['lookup'],
        },
        {
          name: 'private-command', command: 'node', args: ['server.js'],
          env: { MCP_TOKEN: 'saved-env-secret' }, allowedTools: ['lookup'],
        },
      ] }],
    });

    const getResponse = await fetch(`${base}/api/config`);
    const visible = await getResponse.json();
    expect(JSON.stringify(visible)).not.toContain('saved-header-secret');
    expect(JSON.stringify(visible)).not.toContain('saved-env-secret');
    expect(visible.phones[0].mcpServers[0]).toMatchObject({ headers: { Authorization: '••••••' } });
    expect(visible.phones[0].mcpServers[1]).toMatchObject({ env: { MCP_TOKEN: '••••••' } });
    visible.phones[0].mcpServers[0].name = 'renamed-http';

    const saveResponse = await fetch(`${base}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(visible),
    });
    const returned = await saveResponse.json();
    expect(saveResponse.status).toBe(200);
    expect(JSON.stringify(returned)).not.toContain('saved-header-secret');
    expect(JSON.stringify(returned)).not.toContain('saved-env-secret');
    expect(store.get().phones[0].mcpServers[0]).toMatchObject({ headers: { Authorization: 'Bearer saved-header-secret' } });
    expect(store.get().phones[0].mcpServers[1]).toMatchObject({ env: { MCP_TOKEN: 'saved-env-secret' } });
  });

  it('rebinds the live listener when port and LAN settings change', async () => {
    const { base, store, server } = await boot();
    const initialPort = addressOf(server).port;
    const nextPort = await availablePort();
    const portRes = await fetch(base + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ ...store.get(), web: { ...store.get().web, port: nextPort } }),
    });
    expect(portRes.status).toBe(200);
    await waitUntil(() => addressOf(server).port === nextPort);
    expect(addressOf(server)).toMatchObject({ port: nextPort, address: '127.0.0.1' });
    expect((await fetch('http://127.0.0.1:' + nextPort + '/api/status', { headers: { connection: 'close' } })).status).toBe(200);

    const lanRes = await fetch('http://127.0.0.1:' + nextPort + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ ...store.get(), web: { ...store.get().web, lan: true } }),
    });
    expect(lanRes.status).toBe(200);
    await waitUntil(() => addressOf(server).address === '0.0.0.0');
    expect(addressOf(server)).toMatchObject({ port: nextPort, address: '0.0.0.0' });
    expect((await fetch('http://127.0.0.1:' + nextPort + '/api/status', { headers: { connection: 'close' } })).status).toBe(200);
    // A LAN link is usually opened from another app; a Strict cookie would be dropped on that cross-site redirect.
    const link = await fetch(`http://127.0.0.1:${nextPort}/?token=${store.get().web.token}`, { redirect: 'manual', headers: { connection: 'close' } });
    expect(link.status).toBe(302);
    expect(link.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(initialPort).not.toBe(nextPort);
  });

  it('rolls back a failed bind but applies unrelated config changes', async () => {
    const initialPort = await availablePort();
    const { base, hub, store, server } = await boot(initialPort);
    const occupied = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '0.0.0.0', resolve);
    });
    const occupiedPort = addressOf(occupied).port;

    try {
      const next = addPhone(store.get(), 'Work');
      const res = await fetch(base + '/api/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ ...next, web: { ...next.web, port: occupiedPort, lan: true, token: 'new-token' } }),
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('EADDRINUSE') });
      expect(store.get().web).toMatchObject({ port: initialPort, lan: false, token: 'new-token' });
      expect(store.get().phones).toHaveLength(2);
      expect(hub.line(next.phones[1].id)).toBeDefined();
      expect(addressOf(server)).toMatchObject({ port: initialPort, address: '127.0.0.1' });
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('adds a phone with its own port and refuses to delete the last one', async () => {
    const { base, store } = await boot();
    const added = await (await fetch(`${base}/api/phones`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Work' }) })).json();
    expect(added.phones).toHaveLength(2);
    expect(new Set(added.phones.map((p: { line: { port: number } }) => p.line.port)).size).toBe(2);
    expect((await fetch(`${base}/api/phones/${added.phones[1].id}`, { method: 'DELETE' })).status).toBe(200);
    const last = await fetch(`${base}/api/phones/${store.get().phones[0].id}`, { method: 'DELETE' });
    expect(last.status).toBe(400);
  });

  it('refuses duplicate USB dongle assignments before saving them', async () => {
    const { base, store } = await boot();
    const cfg = addPhone(structuredClone(store.get()), 'Work');
    const transport = 'usb:10D7:B012+sco=2';
    cfg.phones[0].line.transport = transport;
    cfg.phones[1].line.transport = transport;
    const res = await fetch(`${base}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('already assigned') });
    expect(store.get().phones.every((phone) => phone.line.transport === '')).toBe(true);
  });

  it('keeps setup writes under Timbre auth and CSRF checks', async () => {
    const { base, hub } = await boot();
    const id = hub.status()[0].id;
    const res = await fetch(`${base}/api/phones/${id}/setup/pairing/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('rejects a cross-site write (CSRF) even from localhost', async () => {
    const { base, store } = await boot();
    const res = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify(store.get()) });
    expect(res.status).toBe(403);
  });
});

describe('MCP endpoint', () => {
  it('refuses a wrong token', async () => {
    const { base, hub } = await boot();
    const id = hub.status()[0].id;
    expect((await rpc(base, id, 'nope', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
  });

  it('initialize, list tools, and chat_send reaches the phone line', async () => {
    const { base, hub, sent } = await boot();
    const id = hub.status()[0].id;
    const token = (hub as unknown as { slots: Map<string, { token: string }> }).slots.get(id)!.token;
    const init = await (await rpc(base, id, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    expect(init.result.serverInfo.name).toBe('timbre');
    const list = await (await rpc(base, id, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain('chat_send');
    const call = await (await rpc(base, id, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chat_send', arguments: { text: 'hi' } } })).json();
    expect(call.result.content[0].text).toBe('sent');
    expect(sent).toEqual(['hi']);
  });

  it('a token only works for its own phone', async () => {
    const { base, hub, store } = await boot();
    const { addPhone } = await import('../src/config/timbre-config.js');
    store.save(addPhone(store.get(), 'Second'));
    await hub.apply();
    const [a, b] = hub.status().map((p) => p.id);
    const tokenA = (hub as unknown as { slots: Map<string, { token: string }> }).slots.get(a)!.token;
    expect((await rpc(base, b, tokenA, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
  });
});
