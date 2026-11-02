import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config/timbre-config.js';
import { Hub, type HubLine } from '../src/hub.js';
import type { PhoneContact } from '../src/phone/phone-config.js';
import { createServer } from '../src/server/server.js';

interface SentSms { phoneId: string; contact: PhoneContact; text: string; clientName?: string }

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

function lanAddress(): string | undefined {
  return Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))?.address;
}

async function boot(options: { listenHost?: string; lan?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'timbre-owner-sms-'));
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
  const makeLine = (phoneId: string) => ({
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    isCallHolder: () => false,
    async sendToSession() { return { sent: true }; },
    async hangup() {}, async inbox() { return []; }, async startCallAgent() { return {}; }, async verifyCaller() { return ''; },
    async startOwnerCallAgent() { return { interactionId: `${phoneId}-interaction`, state: 'dialing' }; },
    isCallerVerified: () => false, async transfer() { return false; }, enterMessageMode() { return false; }, reportCallOutcome() { return false; },
    async sendSms(contact: PhoneContact, text: string, _interactionId?: string, clientName?: string) {
      sent.push({ phoneId, contact, text, clientName });
      return { sent: true };
    },
  } as unknown as HubLine);
  let base = '';
  const hub = new Hub({
    store, dataDir: dir, version: 'test', log: () => {}, mcpUrl: (id) => `${base}/mcp/${id}`,
    createLine: () => makeLine(store.get().phones[0].id),
  });
  await hub.apply();
  const server = createServer({ hub, store, staticDir: path.join(dir, 'none'), dataDir: dir, log: () => {} });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, options.listenHost ?? '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  close = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { base, sent, ownerToken, phoneId: store.get().phones[0].id };
}

describe('owner SMS route', () => {
  it('validates the body and sends through the shared SMS action', async () => {
    const { base, phoneId, sent } = await boot();
    const url = `${base}/api/phones/${phoneId}/sms`;
    const headers = { 'content-type': 'application/json' };

    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ to: '', text: '' }) })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ to: '+61491570156', text: 'x'.repeat(2001) }) })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ to: '+61491570156', text: 'hello', extra: true }) })).status).toBe(400);
    expect(sent).toHaveLength(0);

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ to: '+61491570156', text: 'hello' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sent: true });
    expect(sent).toMatchObject([{ phoneId, text: 'hello', clientName: 'Switchboard', contact: { label: 'Owner', pattern: '+61491570156' } }]);
    expect((await fetch(url, { method: 'GET' })).status).toBe(405);
  });

  it('requires owner authorization for LAN requests, including app-token requests', async () => {
    const address = lanAddress();
    expect(address, 'a non-loopback IPv4 address is required for the LAN auth check').toBeDefined();
    const { base, phoneId, ownerToken } = await boot({ listenHost: '0.0.0.0', lan: true });
    const lanBase = `http://${address}:${new URL(base).port}`;
    const createResponse = await fetch(`${base}/api/app-tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SMS app', phoneIds: [phoneId], actions: ['sms.send'] }),
    });
    const app = await createResponse.json() as { token: string };
    expect(createResponse.status).toBe(201);
    const url = `${lanBase}/api/phones/${phoneId}/sms`;
    const payload = JSON.stringify({ to: '+61491570156', text: 'hello' });
    const headers = { 'content-type': 'application/json' };

    expect((await fetch(url, { method: 'POST', headers, body: payload })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${app.token}` }, body: payload })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${ownerToken}` }, body: payload })).status).toBe(200);
  });
});
