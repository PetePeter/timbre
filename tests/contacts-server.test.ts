import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addPhone, ConfigStore } from '../src/config/timbre-config.js';
import { ContactsStore } from '../src/contacts/contacts-store.js';
import { Hub, type HubLine } from '../src/hub.js';
import { handleContactsRoute } from '../src/server/routes/contacts.js';
import { createServer } from '../src/server/server.js';

function fakeLine(): HubLine {
  return {
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    async sendToSession() { return { sent: true }; }, async hangup() {}, async inbox() { return []; },
    async startCallAgent() { return {}; }, isCallHolder() { return false; }, transfer() { return false; }, enterMessageMode() { return false; }, reportCallOutcome() { return false; },
  };
}

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

async function boot() {
  dir = mkdtempSync(path.join(tmpdir(), 'timbre-contacts-http-'));
  vi.stubEnv('TIMBRE_HOME', dir);
  const config = new ConfigStore(path.join(dir, 'timbre.yaml'));
  const twoPhones = addPhone(config.get(), 'Work');
  config.save({ ...twoPhones, web: { ...twoPhones.web, lan: true, token: 'web-admin-token' } });
  hub = new Hub({
    store: config, dataDir: dir, version: 'test', log: () => {}, mcpUrl: () => '', createLine: () => fakeLine(),
  });
  await hub.apply();
  server = createServer({ hub, store: config, staticDir: dir, log: () => {} });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  const tokens = (hub as unknown as { slots: Map<string, { token: string }> }).slots;
  const phoneIds = config.get().phones.map((phone) => phone.id);
  return {
    base: `http://127.0.0.1:${address.port}`,
    phoneA: phoneIds[0], phoneB: phoneIds[1],
    phoneEntries: config.get().phones,
    tokenA: tokens.get(phoneIds[0])!.token, tokenB: tokens.get(phoneIds[1])!.token,
  };
}

function captureResponse() {
  const result: { status?: number; body?: string } = {};
  const response = {
    writeHead(status: number) { result.status = status; return response; },
    end(body?: string) { result.body = body; return response; },
  } as unknown as ServerResponse;
  return { response, result };
}

function request(base: string, method: string, url: string, token: string, body?: unknown) {
  return fetch(`${base}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('contacts HTTP API', () => {
  it('supports CRUD and lookup while a phone token cannot read another phone book', async () => {
    const { base, phoneA, phoneB, tokenA, tokenB } = await boot();
    const collectionA = `/api/phones/${phoneA}/contacts`;
    const created = await request(base, 'POST', collectionA, tokenA, {
      name: 'Jordan Lee', numbers: ['(0412) 345 678'], group: 'Family', trusted: true, isUser: true,
    });
    expect(created.status).toBe(201);
    const contact = await created.json();
    expect(contact.numbers).toEqual(['+61412345678']);

    const wrongPhone = await request(base, 'GET', `/api/phones/${phoneB}/contacts`, tokenA);
    expect(wrongPhone.status).toBe(401);
    expect(await (await request(base, 'GET', `/api/phones/${phoneB}/contacts`, tokenB)).json()).toEqual([]);

    const lookup = await request(base, 'GET', `${collectionA}/lookup?number=0061%20412%20345%20678`, tokenA);
    expect(await lookup.json()).toEqual([contact]);
    const updated = await request(base, 'PUT', `${collectionA}/${contact.id}`, tokenA, {
      ...contact, name: 'Jordan', numbers: ['+61412345678'], group: 'Home', trusted: false, isUser: true,
    });
    expect((await updated.json()).name).toBe('Jordan');

    expect((await request(base, 'DELETE', `${collectionA}/${contact.id}`, tokenA)).status).toBe(204);
    expect(await (await request(base, 'GET', collectionA, tokenA)).json()).toEqual([]);
  });

  it('keeps both contacts when POST handlers overlap before their request bodies resolve', async () => {
    const { phoneA, phoneEntries } = await boot();
    const phone = phoneEntries.find((entry) => entry.id === phoneA)!;
    const path = `/api/phones/${phoneA}/contacts`;
    let releaseBodies!: () => void;
    const bodyGate = new Promise<void>((resolve) => { releaseBodies = resolve; });
    let signalBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => { signalBothStarted = resolve; });
    let bodyReads = 0;
    const options = {
      phones: [phone],
      log: () => {},
      readJson: async (req: IncomingMessage) => {
        bodyReads++;
        if (bodyReads === 2) signalBothStarted();
        await bodyGate;
        return (req as IncomingMessage & { body: unknown }).body;
      },
    };
    const first = captureResponse();
    const second = captureResponse();
    const firstRequest = handleContactsRoute(
      { method: 'POST', body: { name: 'Jordan', numbers: ['0412345678'], group: '', trusted: true, isUser: false } } as IncomingMessage,
      first.response,
      new URL(`http://localhost${path}`),
      options,
    );
    const secondRequest = handleContactsRoute(
      { method: 'POST', body: { name: 'Casey', numbers: ['0412345679'], group: '', trusted: false, isUser: false } } as IncomingMessage,
      second.response,
      new URL(`http://localhost${path}`),
      options,
    );
    await bothStarted;
    releaseBodies();
    await Promise.all([firstRequest, secondRequest]);

    expect([first.result.status, second.result.status]).toEqual([201, 201]);
    expect(new ContactsStore(dir!, phone.id, phone.line.countryCode).list().map((contact) => contact.name).sort())
      .toEqual(['Casey', 'Jordan']);
  });
});
