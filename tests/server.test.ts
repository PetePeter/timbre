import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config/timbre-config.js';
import { Hub, type HubLine } from '../src/hub.js';
import { authorize, createServer, isLoopback } from '../src/server/server.js';

/** A phone line with no telefony behind it; records what was sent. */
function fakeLine(sent: string[]): HubLine {
  return {
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    async sendToSession(m) { sent.push(m.text); return { sent: true }; },
    async hangup() {}, async inbox() { return []; }, async startCallAgent() { return {}; },
  };
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'timbre-srv-'));
  const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
  const sent: string[] = [];
  let base = '';
  const hub = new Hub({ store, dataDir: dir, version: 't', log: () => {}, mcpUrl: (id) => `${base}/mcp/${id}`, createLine: () => fakeLine(sent) });
  await hub.apply();
  const server = createServer({ hub, store, staticDir: path.join(dir, 'none'), log: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
  return { base, hub, store, sent };
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

  it('PUT /api/config saves the normalized config', async () => {
    const { base, store } = await boot();
    const cfg = store.get();
    const res = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...cfg, phones: [{ ...cfg.phones[0], name: 'Desk' }] }) });
    expect(res.status).toBe(200);
    expect(store.get().phones[0].name).toBe('Desk');
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
