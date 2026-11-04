import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addPhone, ConfigStore } from '../src/config/timbre-config.js';
import { Hub, type HubLine } from '../src/hub.js';
import { JsonlEventStore } from '../src/records/jsonl-event-store.js';
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

async function boot(options: { listenHost?: string; lan?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'timbre-v1-'));
  const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
  const initial = store.get();
  const phone = initial.phones[0];
  const ownerToken = 'owner-web-token';
  const policyContact: PhoneContact = {
    label: 'Owner', pattern: '+614915701*', role: 'owner', callIn: true, callOut: true,
    smsIn: true, smsOut: true, conf: true, pin: '', messages: true,
  };
  store.save({
    ...initial,
    web: { ...initial.web, lan: options.lan ?? false, token: ownerToken },
    phones: [{ ...phone, line: { ...phone.line, masters: { ...phone.line.masters, smsOut: true }, contacts: [policyContact] } }],
  });
  const sent: SentSms[] = [];
  const calls: Array<{ phoneId: string; request: { to: string; task: string }; clientName: string }> = [];
  const makeLine = (phoneId: string) => ({
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    isCallHolder: () => false,
    async sendToSession() { return { sent: true }; },
    async hangup() {}, async inbox() { return []; }, async startCallAgent() { return {}; }, async verifyCaller() { return ''; },
    async startOwnerCallAgent(request: { to: string; task: string }, clientName: string) {
      calls.push({ phoneId, request, clientName });
      return { interactionId: `${phoneId}-interaction`, state: 'dialing' };
    },
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
  return { base, dir, store, hub, sent, calls, ownerToken, phoneId: store.get().phones[0].id, addPhone: async () => {
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
    const response = await fetch(`${base}/v1/phones/${phoneId}/sms`);
    expect(response.status).toBe(401);
    expect((await fetch(`${base}/v1/phones`)).status).toBe(401);

    const document = openApiDocument();
    expect(Object.keys(document.paths).sort()).toEqual([...new Set(v1Routes.map((route) => route.path))].sort());
    for (const route of v1Routes) expect(document.paths[route.path]?.[route.method.toLowerCase()]).toBeDefined();
    expect(document.paths['/v1/phones']?.get).toMatchObject({ security: [{ AppToken: [] }] });
  });

  it('lists only token-accessible phones with non-secret fields', async () => {
    const { base, phoneId, addPhone } = await boot();
    const otherPhone = await addPhone();
    const scoped = await createToken(base, { name: 'One phone', phoneIds: [phoneId], actions: ['sms.list'] });
    const all = await createToken(base, { name: 'All phones', phoneIds: ['*'], actions: ['calls.make'] });

    const oneResponse = await fetch(`${base}/v1/phones`, { headers: { authorization: `Bearer ${scoped.body.token}` } });
    const one = await oneResponse.json() as Array<Record<string, unknown>>;
    expect(oneResponse.status).toBe(200);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ id: phoneId, name: expect.any(String) });
    expect(Object.keys(one[0]).sort()).toEqual(['id', 'name', 'status']);
    expect(JSON.stringify(one)).not.toContain(otherPhone);

    const allResponse = await fetch(`${base}/v1/phones`, { headers: { authorization: `Bearer ${all.body.token}` } });
    const phones = await allResponse.json() as Array<{ id: string; name: string }>;
    expect(phones.map((phone) => phone.id).sort()).toEqual([phoneId, otherPhone].sort());
  });

  it('sends SMS through the phone line with the app name and enforces token phone/action scopes', async () => {
    const { base, phoneId, sent, calls, addPhone } = await boot();
    const otherPhone = await addPhone();
    const { response: createResponse, body } = await createToken(base, {
      name: 'Calendar', phoneIds: [phoneId], actions: ['sms.send', 'calls.make'],
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
    expect((await fetch(`${base}/v1/phones/${phoneId}/sms`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/v1/phones/${phoneId}/calls`, { method: 'POST', headers, body: '{}' })).status).toBe(400);
    expect((await fetch(`${base}/v1/phones/${phoneId}/calls`, { method: 'POST', headers, body: JSON.stringify({ to: '0298765432', task: 'Book a table' }) })).status).toBe(202);
    expect((await fetch(`${base}/v1/phones/${phoneId}/calls`, {
      method: 'POST', headers: { ...headers, authorization: `Bearer ${(await createToken(base, { name: 'SMS only', phoneIds: [phoneId], actions: ['sms.send'] })).body.token}` },
      body: JSON.stringify({ to: '0298765432', task: 'Book a table' }),
    })).status).toBe(403);
    expect(calls).toMatchObject([{ phoneId, request: { to: '0298765432', task: 'Book a table' }, clientName: 'Calendar' }]);
  });

  it('routes an owner Switchboard call through the same action and requires owner auth over LAN', async () => {
    const address = lanAddress();
    expect(address, 'a non-loopback IPv4 address is required for the LAN auth check').toBeDefined();
    const { base, phoneId, calls, ownerToken } = await boot({ listenHost: '0.0.0.0', lan: true });
    const lanBase = `http://${address}:${new URL(base).port}`;
    const { body: app } = await createToken(base, { name: 'Untrusted app', phoneIds: [phoneId], actions: ['calls.make'] });
    const path = `/api/phones/${phoneId}/calls`;
    const request = { to: '0298765432', task: 'Book an appointment' };

    expect((await fetch(lanBase + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })).status).toBe(401);
    expect((await fetch(lanBase + path, { method: 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) })).status).toBe(401);
    const invalid = await fetch(lanBase + path, {
      method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: '  ', task: 'Book an appointment' }),
    });
    expect(invalid.status).toBe(400);
    expect(calls).toHaveLength(0);
    const response = await fetch(lanBase + path, {
      method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ interactionId: `${phoneId}-interaction`, state: 'dialing' });
    expect(calls).toMatchObject([{ phoneId, request, clientName: 'Switchboard' }]);
  });

  it('serves the OpenAPI document and Swagger UI from the local package to an app token', async () => {
    const { base, phoneId } = await boot();
    const { body } = await createToken(base, { name: 'Docs', phoneIds: [phoneId], actions: ['sms.list'] });
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
    const { body } = await createToken(base, { name: 'LAN docs', phoneIds: [phoneId], actions: ['sms.list'] });
    const tokenHeaders = { authorization: `Bearer ${body.token}` };

    for (const route of ['/api/docs', '/v1/openapi.json']) {
      expect((await fetch(`${lanBase}${route}`)).status).toBe(401);
      expect((await fetch(`${lanBase}${route}`, { headers: tokenHeaders })).status).toBe(200);
    }
  });

  it('never lets an app edit contacts', async () => {
    const { base, phoneId } = await boot();
    expect((await createToken(base, { name: 'Editor', phoneIds: [phoneId], actions: ['contacts.write'] })).response.status).toBe(400);
    const { body } = await createToken(base, { name: 'People', phoneIds: [phoneId], actions: ['contacts.list'] });
    const headers = { authorization: `Bearer ${body.token}`, 'content-type': 'application/json' };
    const contact = JSON.stringify({ name: 'Sam', numbers: ['0412345678'], group: 'Friends', trusted: false, isUser: false });

    expect((await fetch(`${base}/v1/phones/${phoneId}/contacts`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/phones/${phoneId}/contacts/lookup?number=0412345678`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/phones/${phoneId}/contacts`, { method: 'POST', headers, body: contact })).status).toBe(405);
    expect((await fetch(`${base}/v1/phones/${phoneId}/contacts/c1`, { method: 'PUT', headers, body: contact })).status).toBe(404);
    expect((await fetch(`${base}/v1/phones/${phoneId}/contacts/c1`, { method: 'DELETE', headers })).status).toBe(404);
  });

  it('scopes SMS and call records separately for list, lookup and search', async () => {
    const { base, phoneId, dir } = await boot();
    const events = new JsonlEventStore(dir, () => {});
    const at = new Date().toISOString();
    events.append(phoneId, { eventId: 'e-sms', interactionId: 'sms-1', kind: 'sms', type: 'sms.received', occurredAt: at, details: { from: '+61491570156', text: 'hello there' } });
    events.append(phoneId, { eventId: 'e-call', interactionId: 'call-1', kind: 'call', type: 'call.started', occurredAt: at, details: { from: '+61491570156' } });
    const smsToken = (await createToken(base, { name: 'Texts', phoneIds: [phoneId], actions: ['sms.list'] })).body.token;
    const callToken = (await createToken(base, { name: 'Calls', phoneIds: [phoneId], actions: ['calls.list'] })).body.token;
    const get = async (token: string, route: string) => fetch(`${base}/v1/phones/${phoneId}${route}`, { headers: { authorization: `Bearer ${token}` } });
    const ids = async (response: Response) => ((await response.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id);

    expect(await ids(await get(smsToken, '/sms'))).toEqual(['sms-1']);
    expect((await get(smsToken, '/sms/sms-1')).status).toBe(200);
    expect((await get(smsToken, '/sms/call-1')).status).toBe(404);
    expect((await get(smsToken, '/calls')).status).toBe(403);
    expect((await get(smsToken, '/calls/call-1')).status).toBe(403);
    expect(await ids(await get(callToken, '/calls'))).toEqual(['call-1']);
    expect((await get(callToken, '/calls/sms-1')).status).toBe(404);
    expect((await get(callToken, '/sms')).status).toBe(403);
    expect((await get(callToken, '/sms/search?q=hello')).status).toBe(403);
    expect((await get(smsToken, '/sms?limit=101')).status).toBe(400);
    expect((await get(smsToken, '/sms?limit=2&limit=3')).status).toBe(400);
  });

  it('lists call skills with calls.make scope and accepts a saved skill on the shared call route', async () => {
    const { base, phoneId, calls } = await boot();
    const reader = (await createToken(base, { name: 'Reader', phoneIds: [phoneId], actions: ['sms.list'] })).body.token;
    const caller = (await createToken(base, { name: 'Caller', phoneIds: [phoneId], actions: ['calls.make'] })).body.token;

    expect((await fetch(`${base}/v1/call-skills`, { headers: { authorization: `Bearer ${reader}` } })).status).toBe(403);
    const listed = await fetch(`${base}/v1/call-skills`, { headers: { authorization: `Bearer ${caller}` } });
    expect(listed.status).toBe(200);
    const skills = await listed.json() as Array<{ id: string; name: string }>;
    const appointment = skills.find((skill) => skill.name === 'Book an appointment');
    expect(appointment).toBeTruthy();

    const response = await fetch(`${base}/v1/phones/${phoneId}/calls`, {
      method: 'POST', headers: { authorization: `Bearer ${caller}`, 'content-type': 'application/json' },
      body: JSON.stringify({ skillId: appointment!.id, params: { number: '0298765432', business: 'the mechanic', service: 'book a service' } }),
    });
    expect(response.status).toBe(202);
    expect(calls[0].request.to).toBe('0298765432');
    expect(calls[0].request.task).toContain('"business": "the mechanic"');

    const incomplete = await fetch(`${base}/v1/phones/${phoneId}/calls`, {
      method: 'POST', headers: { authorization: `Bearer ${caller}`, 'content-type': 'application/json' },
      body: JSON.stringify({ skillId: appointment!.id, params: { number: '0298765432' } }),
    });
    expect(incomplete.status).toBe(400);
    expect(calls).toHaveLength(1);
  });
});
