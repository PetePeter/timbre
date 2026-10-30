import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config/timbre-config.js';
import { telefonyAdminPort } from '../src/phone/setup/telefony-admin.js';
import type { PairingConfirmation, PairingStatus, PairingStart, PairingConfirmationResult, TelefonySetupApi } from '../src/phone/setup/telefony-admin-client.js';
import { handlePhoneSetupRoute, matchPhoneSetupRoute } from '../src/server/routes/phone-setup.js';

const dataDirs: string[] = [];
function tempDataDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'timbre-phone-setup-'));
  dataDirs.push(directory);
  return directory;
}

afterEach(() => { for (const directory of dataDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function routeRequest(method: string, path: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(req, { method, url: path });
  const result = { status: 0, body: '' };
  const res = {
    writeHead(status: number) { result.status = status; return this; },
    end(bodyText?: string | Buffer) { result.body = bodyText?.toString() ?? ''; return this; },
  } as unknown as ServerResponse;
  return { req, res, result };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += chunk.toString();
  return JSON.parse(text || '{}');
}

function fakeApi() {
  let status: PairingStatus = { pairingId: 'pair-1', state: 'discoverable', deviceName: 'telefony' };
  const api: TelefonySetupApi = {
    startPairing: vi.fn(async (_timeout?: number): Promise<PairingStart> => ({ pairingId: 'pair-1', state: 'discoverable', deviceName: 'telefony', expiresAt: 'later' })),
    pairingStatus: vi.fn(async () => {
      status = { pairingId: 'pair-1', state: 'awaiting-confirmation', phone: { address: 'AA:BB:CC:DD:EE:FF' }, numericCode: '123456' };
      return status;
    }),
    confirmPairing: vi.fn(async (input: PairingConfirmation): Promise<PairingConfirmationResult> => {
      status = input.accept
        ? { pairingId: input.pairingId, state: 'paired', phone: { address: input.address, name: 'Phone' } }
        : { pairingId: input.pairingId, state: 'rejected' };
      return status as PairingConfirmationResult;
    }),
    cancelPairing: vi.fn(async (pairingId: string) => ({ pairingId, state: 'cancelled' })),
  };
  return api;
}

describe('phone setup routes', () => {
  it('matches only the setup API paths', () => {
    expect(matchPhoneSetupRoute('/api/phone-setup/dongles')).toEqual({ action: 'dongles' });
    expect(matchPhoneSetupRoute('/api/phones/abc-123/setup/pairing/confirm')).toEqual({ phoneId: 'abc-123', action: 'pairing-confirm' });
    expect(matchPhoneSetupRoute('/api/phones/abc/setup/pairing/unknown')).toBeNull();
  });

  it('lists dongles with assignment conflicts marked by the owning phone', async () => {
    const cfg = defaultConfig();
    const phone = cfg.phones[0];
    phone.line.transport = 'usb:10D7:B012+sco=2';
    const listDongles = vi.fn(async () => ({
      dongles: [{ id: '10D7:B012', name: 'USB radio', driver: 'libusbK' as const, probeAvailable: true }],
      pnpError: 'PnP query unavailable',
    }));
    const { req, res, result } = routeRequest('GET', '/api/phone-setup/dongles');
    await handlePhoneSetupRoute(req, res, { action: 'dongles' }, { phones: cfg.phones, dataDir: 'unused', readJson, listDongles });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).dongles[0]).toMatchObject({ id: '10D7:B012', inUseBy: phone.name });
    expect(JSON.parse(result.body).pnpError).toBe('PnP query unavailable');
  });

  it('accepts any existing PhAP executable path to locate bumble-usb-probe', async () => {
    const cfg = defaultConfig();
    const listDongles = vi.fn(async () => ({ dongles: [] }));
    const executable = process.execPath;
    const { req, res, result } = routeRequest('POST', '/api/phone-setup/dongles', { executable });
    await handlePhoneSetupRoute(req, res, { action: 'dongles' }, { phones: cfg.phones, dataDir: 'unused', readJson, listDongles });
    expect(result.status).toBe(200);
    const probeName = process.platform === 'win32' ? 'bumble-usb-probe.exe' : 'bumble-usb-probe';
    expect(listDongles).toHaveBeenCalledWith(path.join(path.dirname(executable), probeName));

    const invalid = routeRequest('POST', '/api/phone-setup/dongles', { executable: path.join(tempDataDir(), 'missing-server.exe') });
    await handlePhoneSetupRoute(invalid.req, invalid.res, { action: 'dongles' }, { phones: cfg.phones, dataDir: 'unused', readJson, listDongles });
    expect(invalid.result.status).toBe(400);
    expect(JSON.parse(invalid.result.body).error).toBe('executable must be an existing executable file');
  });

  it('runs discover, state, code confirmation and cancel through the telefony edge', async () => {
    const cfg = defaultConfig();
    const phone = cfg.phones[0];
    phone.line.transport = 'usb:10D7:B012+sco=2';
    const dataDir = tempDataDir();
    const client = fakeApi();
    const options = { phones: cfg.phones, dataDir, readJson, clientForPhone: async () => client };

    const start = routeRequest('POST', `/api/phones/${phone.id}/setup/pairing/start`, { timeoutSeconds: 180 });
    await handlePhoneSetupRoute(start.req, start.res, matchPhoneSetupRoute(start.req.url!)!, options);
    expect(start.result.status).toBe(200);
    expect(client.startPairing).toHaveBeenCalledWith(180);

    const status = routeRequest('GET', `/api/phones/${phone.id}/setup/pairing`);
    await handlePhoneSetupRoute(status.req, status.res, matchPhoneSetupRoute(status.req.url!)!, options);
    expect(JSON.parse(status.result.body)).toMatchObject({ state: 'awaiting-confirmation', numericCode: '123456' });

    const confirm = routeRequest('POST', `/api/phones/${phone.id}/setup/pairing/confirm`, {
      pairingId: 'pair-1', address: 'aa:bb:cc:dd:ee:ff', numericCode: '123456', accept: true,
    });
    await handlePhoneSetupRoute(confirm.req, confirm.res, matchPhoneSetupRoute(confirm.req.url!)!, options);
    expect(confirm.result.status).toBe(200);
    expect(JSON.parse(confirm.result.body).state).toBe('paired');
    expect(client.confirmPairing).toHaveBeenCalledWith({ pairingId: 'pair-1', address: 'AA:BB:CC:DD:EE:FF', numericCode: '123456', accept: true });

    const cancel = routeRequest('POST', `/api/phones/${phone.id}/setup/pairing/cancel`, { pairingId: 'pair-1' });
    await handlePhoneSetupRoute(cancel.req, cancel.res, matchPhoneSetupRoute(cancel.req.url!)!, options);
    expect(cancel.result.status).toBe(200);
  });

  it('rejects invalid pairing inputs, missing phones and admin-port conflicts', async () => {
    const cfg = defaultConfig();
    const phone = cfg.phones[0];
    const dataDir = tempDataDir();
    const client = fakeApi();
    const options = { phones: cfg.phones, dataDir, readJson, clientForPhone: async () => client };
    const bad = routeRequest('POST', `/api/phones/${phone.id}/setup/pairing/confirm`, { pairingId: 'x', address: 'not a mac', numericCode: '123', accept: true });
    await handlePhoneSetupRoute(bad.req, bad.res, matchPhoneSetupRoute(bad.req.url!)!, options);
    expect(bad.result.status).toBe(400);
    expect(client.confirmPairing).not.toHaveBeenCalled();

    const missing = routeRequest('GET', '/api/phones/missing/setup/pairing');
    await handlePhoneSetupRoute(missing.req, missing.res, matchPhoneSetupRoute(missing.req.url!)!, options);
    expect(missing.result.status).toBe(404);

    phone.line.port = await telefonyAdminPort(phone.id, path.join(dataDir, 'phones'));
    const conflict = routeRequest('GET', `/api/phones/${phone.id}/setup/pairing`);
    await handlePhoneSetupRoute(conflict.req, conflict.res, matchPhoneSetupRoute(conflict.req.url!)!, options);
    expect(conflict.result.status).toBe(409);
  });

  it('passes a telefony failure state back to the wizard', async () => {
    const cfg = defaultConfig();
    const failed: TelefonySetupApi = {
      ...fakeApi(),
      pairingStatus: async () => ({ pairingId: 'pair-1', state: 'failed', error: { code: 'adapter', message: 'Adapter stopped' } }),
    };
    const dataDir = tempDataDir();
    const { req, res, result } = routeRequest('GET', `/api/phones/${cfg.phones[0].id}/setup/pairing`);
    await handlePhoneSetupRoute(req, res, matchPhoneSetupRoute(req.url!)!, {
      phones: cfg.phones, dataDir, readJson, clientForPhone: async () => failed,
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ state: 'failed', error: { code: 'adapter' } });
  });
});
