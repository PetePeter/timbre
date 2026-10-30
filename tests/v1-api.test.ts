import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addPhone, ConfigStore } from '../src/config/timbre-config.js';
import { Hub, type HubLine } from '../src/hub.js';
import type { PhoneContact } from '../src/phone/phone-config.js';
import { createServer } from '../src/server/server.js';
import { openApiDocument, v1Routes } from '../src/server/routes/v1/contract.js';

interface SentSms { phoneId: string; contact: PhoneContact; text: string; interactionId?: string; clientName?: string }

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

function lanAddress(): string | undefined {
  return Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))?.address;
}

async function boot(options: { listenHost?: string } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'timbre-v1-'));
  const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
  const initial = store.get();
  const phone = initial.phones[0];
  const policyContact: PhoneContact = {
    label: 'Owner', pattern: '+614915701*', role: 'owner', callIn: true, callOut: true,
    smsIn: true, smsOut: true, conf: true, pin: '', messages: true,
  };
  store.save({
    ...initial,
    phones: [{ ...phone, line: { ...phone.line, masters: { ...phone.line.masters, smsOut: true }, contacts: [policyContact] } }],
  });
  const sent: SentSms[] = [];
  const makeLine = (phoneId: string) => ({
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    isCallHolder: () => false,
    async sendToSession() { return { sent: true }; },
    async hangup() {}, async inbox() { return []; }, async startCallAgent() { return {}; }, async verifyCaller() { return ''; },
    isCallerVerified: () => false, async transfer() { return false; }, enterMessageMode() { return false; }, reportCallOutcome() { return false; },
    async sendSms(contact: PhoneContact, text: string, interactionId?: string, clientName?: string) {
      sent.push({ phoneId, contact, text, interactionId, clientName });
      return { sent: true };
    },
  } as unknown as HubLine);
  let base = '';
  const hub = new Hub({
    store, dataDir: dir, version: 'test', log: () => {}, mcpUrl: (id) => `${base}/mcp/${id}`,
    createLine: (_deps) => makeLine(store.get().phones[0].id),
  });
  await hub.apply();
  const server = createServer({ hub, store, staticDir: path.join(dir, 'none'), dataDir: dir, log: () => {} });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, options.listenHost ?? '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  const dispose = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  close = dispose;
  return { base, store, hub, sent, phoneId: store.get().phones[0].id, addPhone: async () => {
    store.save(addPhone(store.get(), 'Second'));
    await hub.apply();
    return store.get().phones[1].id;
  } };
}

async function createToken(base: string, input: { name: string; phoneIds: string[]; actions: string[] }) {
  const response = await fetch(`${base}/api/app-tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  return { response, body: await response.json() as { token: string; app: { id: string; name: string } } };
}

describe('versioned REST API', () => {
  it('uses the route contract as the OpenAPI path source and rejects unauthenticated action requests', async () => {
    const { base, phoneId } = await boot();
    const response = await fetch(`${base}/v1/phones/${phoneId}/records`);
    expect(response.status).toBe(401);

    const document = openApiDocument();
    expect(Object.keys(document.paths).sort()).toEqual([...new Set(v1Routes.map((route) => route.path))].sort());
    for (const route of v1Routes) expect(document.paths[route.path]?.[route.method.toLowerCase()]).toBeDefined();
  });

  it('sends SMS through the phone line with the app name and enforces token phone/action scopes', async () => {
    const { base, phoneId, sent, addPhone } = await boot();
    const otherPhone = await addPhone();
    const { response: createResponse, body } = await createToken(base, {
      name: 'Calendar', phoneIds: [phoneId], actions: ['sms.send', 'calls.create'],
    });
    expect(createResponse.status).toBe(201);
    const headers = { authorization: `Bearer ${body.token}`, 'content-type': 'application/json' };

    const invalid = await fetch(`${base}/v1/phones/${phoneId}/sms`, { method: 'POST', headers, body: JSON.stringify({ to: '', text: '' }) });
    expect(invalid.status).toBe(400);
    expect(sent).toHaveLength(0);

    const sms = await fetch(`${base}/v1/phones/${phoneId}/sms`, {
      method: 'POST', headers, body: JSON.stringify({ to: '+61491570156', text: 'hello' }),
    });
    expect(sms.status).toBe(200);
    expect(await sms.json()).toMatchObject({ sent: true });
    expect(sent).toMatchObject([{ phoneId, text: 'hello', clientName: 'Calendar', contact: { label: 'Owner', pattern: '+61491570156' } }]);

    expect((await fetch(`${base}/v1/phones/${otherPhone}/sms`, { method: 'POST', headers, body: JSON.stringify({ to: '+61491570156', text: 'hello' }) })).status).toBe(403);
    expect((await fetch(`${base}/v1/phones/${phoneId}/records`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/v1/phones/${phoneId}/calls`, { method: 'POST', headers, body: '{}' })).status).toBe(501);
  });

  it('serves the OpenAPI document and Swagger UI from the local package to an app token', async () => {
    const { base, phoneId } = await boot();
    const { body } = await createToken(base, { name: 'Docs', phoneIds: [phoneId], actions: ['records.read'] });
    const headers = { authorization: `Bearer ${body.token}` };

    const doc = await fetch(`${base}/v1/openapi.json`, { headers });
    expect(doc.status).toBe(200);
    expect((await doc.json()).openapi).toBe('3.1.0');
    const ui = await fetch(`${base}/api/docs`, { headers });
    expect(ui.status).toBe(200);
    const html = await ui.text();
    expect(html).toContain('/api/docs/swagger-ui-bundle.js');
    expect(html).not.toMatch(/https?:\/\/(?:unpkg|cdn\.jsdelivr)/i);
    const asset = await fetch(`${base}/api/docs/swagger-ui.css`, { headers });
    expect(asset.status).toBe(200);
  });

  it('requires a valid token for the docs and OpenAPI routes over a LAN address', async () => {
    const address = lanAddress();
    expect(address, 'a non-loopback IPv4 address is required for the LAN auth check').toBeDefined();
    const { base, phoneId } = await boot({ listenHost: '0.0.0.0' });
    const lanBase = `http://${address}:${new URL(base).port}`;
    const { body } = await createToken(base, { name: 'LAN docs', phoneIds: [phoneId], actions: ['records.read'] });
    const tokenHeaders = { authorization: `Bearer ${body.token}` };

    for (const route of ['/api/docs', '/v1/openapi.json']) {
      expect((await fetch(`${lanBase}${route}`)).status).toBe(401);
      expect((await fetch(`${lanBase}${route}`, { headers: tokenHeaders })).status).toBe(200);
    }
  });

  it('supports contact CRUD through the shared API contract', async () => {
    const { base, phoneId } = await boot();
    const { body } = await createToken(base, { name: 'People', phoneIds: [phoneId], actions: ['contacts.read', 'contacts.write'] });
    const headers = { authorization: `Bearer ${body.token}`, 'content-type': 'application/json' };
    const contact = { name: 'Sam', numbers: ['0412345678'], group: 'Friends', trusted: false, isUser: false };

    const create = await fetch(`${base}/v1/phones/${phoneId}/contacts`, { method: 'POST', headers, body: JSON.stringify(contact) });
    expect(create.status).toBe(201);
    const created = await create.json() as { id: string; name: string };
    expect(created.name).toBe('Sam');
    expect((await fetch(`${base}/v1/phones/${phoneId}/contacts`, { headers })).status).toBe(200);
    const update = await fetch(`${base}/v1/phones/${phoneId}/contacts/${created.id}`, { method: 'PUT', headers, body: JSON.stringify({ ...contact, name: 'Samuel' }) });
    expect(update.status).toBe(200);
    expect((await fetch(`${base}/v1/phones/${phoneId}/contacts/lookup?number=0412345678`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/phones/${phoneId}/contacts/${created.id}`, { method: 'DELETE', headers })).status).toBe(204);
  });

  it('validates record queries and keeps the static contact lookup route reserved', async () => {
    const { base, phoneId } = await boot();
    const { body } = await createToken(base, { name: 'Reader', phoneIds: [phoneId], actions: ['records.read', 'search.read', 'contacts.read'] });
    const headers = { authorization: `Bearer ${body.token}` };
    expect((await fetch(`${base}/v1/phones/${phoneId}/records?limit=101`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/v1/phones/${phoneId}/records?limit=2&limit=3`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/v1/phones/${phoneId}/records`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/phones/${phoneId}/records/missing`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/v1/phones/${phoneId}/search?q=hello`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/phones/${phoneId}/contacts/lookup`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status).toBe(405);
  });
});
