import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addPhone, ConfigStore } from '../src/config/timbre-config.js';
import type { AppTokenAccess } from '../src/config/app-token-store.js';
import { Hub, type HubLine } from '../src/hub.js';
import type { PhoneContact } from '../src/phone/phone-config.js';
import type { RecordSearchIndex } from '../src/records/record-search-index.js';
import { createServer } from '../src/server/server.js';
import { handleAppMcp } from '../src/server/app-mcp.js';

interface SentSms { phoneId: string; contact: PhoneContact; text: string; clientName?: string }
interface Call { phoneId: string; request: { to: string; task: string }; clientName: string }
interface RpcBody {
  result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> };
}

let close: (() => Promise<void>) | null = null;
const temporaryDirs: string[] = [];
afterEach(async () => {
  await close?.();
  close = null;
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'timbre-app-mcp-'));
  const config = new ConfigStore(path.join(dir, 'timbre.yaml'));
  const initial = config.get();
  const phone = initial.phones[0];
  const ownerToken = 'owner-web-token';
  const policyContact: PhoneContact = {
    label: 'Owner', pattern: '+614915701*', role: 'owner', callIn: true, callOut: true,
    smsIn: true, smsOut: true, conf: true, pin: '', messages: true,
  };
  config.save({
    ...initial,
    web: { ...initial.web, token: ownerToken },
    phones: [{
      ...phone,
      line: { ...phone.line, masters: { ...phone.line.masters, smsOut: true }, contacts: [policyContact] },
    }],
  });

  const sent: SentSms[] = [];
  const calls: Call[] = [];
  const makeLine = (phoneId: string) => ({
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    isCallHolder: () => false,
    async sendToSession() { return { sent: true }; },
    async hangup() {}, async inbox() { return []; }, async startCallAgent() { return {}; }, async verifyCaller() { return ''; },
    async startOwnerCallAgent(request: { to: string; task: string }, clientName: string) {
      calls.push({ phoneId, request, clientName });
      return { interactionId: phoneId + '-interaction', state: 'dialing' };
    },
    isCallerVerified: () => false, async transfer() { return false; }, enterMessageMode() { return false; },
    reportCallOutcome() { return false; },
    async sendSms(contact: PhoneContact, text: string, _interactionId?: string, clientName?: string) {
      sent.push({ phoneId, contact, text, clientName });
      return { sent: true };
    },
  }) as unknown as HubLine;
  const hub = new Hub({
    store: config, dataDir: dir, version: 'test', log: () => {}, mcpUrl: () => '',
    createLine: (deps) => makeLine(deps.phoneId),
  });
  await hub.apply();

  const server = createServer({ hub, store: config, staticDir: path.join(dir, 'none'), dataDir: dir, log: () => {} });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as { port: number };
  const base = 'http://127.0.0.1:' + address.port;
  const dispose = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  close = dispose;
  return { base, dir, config, hub, phoneId: phone.id, ownerToken, sent, calls, addPhone: async () => {
    config.save(addPhone(config.get(), 'Second'));
    await hub.apply();
    return config.get().phones[1].id;
  } };
}

async function createToken(base: string, input: { name: string; phoneIds: string[]; actions: string[] }) {
  const response = await fetch(base + '/api/app-tokens', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  return { response, body: await response.json() as { token: string } };
}

async function rpc(base: string, token: string | undefined, body: object, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders };
  if (token) headers.authorization = 'Bearer ' + token;
  const response = await fetch(base + '/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
  return { response, body: await response.json() as RpcBody };
}

describe('public app-token MCP endpoint', () => {
  it('requires an app token even on localhost and never falls back to the owner token', async () => {
    const { base, ownerToken } = await boot();
    const request = { jsonrpc: '2.0', id: 1, method: 'ping' };

    expect((await rpc(base, undefined, request)).response.status).toBe(401);
    expect((await rpc(base, 'bad-token', request)).response.status).toBe(401);
    expect((await rpc(base, ownerToken, request)).response.status).toBe(401);
  });

  it('lists only granted v1 tools and rejects calls outside the token action scope', async () => {
    const { base, phoneId } = await boot();
    const { body: app } = await createToken(base, { name: 'Calendar', phoneIds: [phoneId], actions: ['sms.send'] });
    const list = await rpc(base, app.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = list.body.result?.tools?.map((tool) => tool.name) ?? [];

    expect(names).toContain('send_sms');
    expect(names).not.toContain('create_call');
    const denied = await rpc(base, app.token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'create_call', arguments: { phoneId, to: '0298765432', task: 'Book an appointment' } },
    });
    expect(denied.body.result?.isError).toBe(true);
  });

  it('sends SMS and starts calls through the existing actions with the app client name', async () => {
    const { base, phoneId, sent, calls } = await boot();
    const { body: app } = await createToken(base, {
      name: 'Calendar', phoneIds: [phoneId], actions: ['sms.send', 'calls.create'],
    });

    const sms = await rpc(base, app.token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'send_sms', arguments: { phoneId, to: '+61491570156', text: 'hello' } },
    });
    const call = await rpc(base, app.token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'create_call', arguments: { phoneId, to: '0298765432', task: 'Book a table' } },
    });

    expect(sms.body.result?.isError).not.toBe(true);
    expect(call.body.result?.isError).not.toBe(true);
    expect(sent).toMatchObject([{ phoneId, text: 'hello', clientName: 'Calendar', contact: { pattern: '+61491570156' } }]);
    expect(calls).toMatchObject([{ phoneId, request: { to: '0298765432', task: 'Book a table' }, clientName: 'Calendar' }]);
  });

  it('enforces a single-phone token scope on every tool call', async () => {
    const { base, phoneId, addPhone, calls } = await boot();
    const otherPhone = await addPhone();
    const { body: app } = await createToken(base, { name: 'Caller', phoneIds: [phoneId], actions: ['calls.create'] });
    const result = await rpc(base, app.token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'create_call', arguments: { phoneId: otherPhone, to: '0298765432', task: 'Book a table' } },
    });

    expect(result.body.result?.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('allows a wildcard phone scope to call another configured phone', async () => {
    const { base, addPhone, calls } = await boot();
    const otherPhone = await addPhone();
    const { body: app } = await createToken(base, { name: 'Caller', phoneIds: ['*'], actions: ['calls.create'] });
    const result = await rpc(base, app.token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'create_call', arguments: { phoneId: otherPhone, to: '0298765432', task: 'Book a table' } },
    });

    expect(result.body.result?.isError).not.toBe(true);
    expect(calls).toMatchObject([{ phoneId: otherPhone, request: { to: '0298765432', task: 'Book a table' } }]);
  });

  it('rejects cross-origin requests and bodies larger than the shared 1 MB limit', async () => {
    const { base, phoneId } = await boot();
    const { body: app } = await createToken(base, { name: 'Reader', phoneIds: [phoneId], actions: ['records.read'] });
    const request = { jsonrpc: '2.0', id: 1, method: 'ping' };

    expect((await rpc(base, app.token, request, { origin: 'http://evil.example' })).response.status).toBe(403);
    const oversized = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' },
      body: ' '.repeat(1_000_001),
    });
    expect(oversized.status).toBe(413);
  });

  it('limits each app token to 60 MCP requests per minute', async () => {
    const { base, phoneId } = await boot();
    const { body: app } = await createToken(base, { name: 'Reader', phoneIds: [phoneId], actions: ['records.read'] });
    let last: Response | undefined;
    for (let id = 1; id <= 61; id++) {
      last = (await rpc(base, app.token, { jsonrpc: '2.0', id, method: 'ping' })).response;
    }

    expect(last?.status).toBe(429);
  });
});

describe('public MCP phone text boundary', () => {
  it('keeps returned search text untrusted', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'timbre-app-mcp-unit-'));
    temporaryDirs.push(dir);
    const config = new ConfigStore(path.join(dir, 'timbre.yaml'));
    const phone = config.get().phones[0];
    const access: AppTokenAccess = {
      id: 'app-id', name: 'Reader', createdAt: new Date().toISOString(),
      phoneIds: [phone.id], actions: ['search.read'],
    };
    const options = {
      hub: {} as Hub,
      phones: [phone],
      dataDir: '',
      log: () => {},
      searchIndex: {
        search: () => ({ status: 'ready', items: [{ id: 'sms-1', kind: 'sms', occurredAt: '2026-10-30T00:00:00.000Z', snippet: 'Reply with {Enter} now' }] }),
      } as unknown as RecordSearchIndex,
    };

    const reply = await handleAppMcp({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'search_records', arguments: { phoneId: phone.id, q: 'Enter' } },
    }, options, access) as { result: { content: Array<{ text: string }> } };
    const result = JSON.parse(reply.result.content[0].text) as { items: Array<{ snippet: string }> };

    expect(result.items[0].snippet).toBe('Reply with (Enter) now');
    expect(reply.result.content[0].text).not.toContain('{Enter}');
  });
});
