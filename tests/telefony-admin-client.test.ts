import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TelefonyAdminClient } from '../src/phone/setup/telefony-admin-client.js';

describe('TelefonyAdminClient', () => {
  it('speaks the authenticated pairing contract to a fake loopback admin server', async () => {
    const requests: Array<{ method: string; path: string; authorization?: string; telefony?: string; body: unknown }> = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization, telefony: req.headers['x-telefony'] as string | undefined, body });
      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== 'Bearer private-token') return reply(401, { error: 'bad token' });
      if (req.method === 'POST' && req.headers['x-telefony'] !== '1') return reply(403, { error: 'CSRF header required' });
      if (req.method === 'POST' && req.url === '/api/setup/pairing') return reply(200, { pairingId: 'pair-1', state: 'discoverable', deviceName: 'telefony', expiresAt: 'later' });
      if (req.method === 'GET' && req.url === '/api/setup/pairing') return reply(200, { pairingId: 'pair-1', state: 'awaiting-confirmation', phone: { address: 'AA:BB:CC:DD:EE:FF' }, numericCode: '123456' });
      if (req.method === 'POST' && req.url === '/api/setup/pairing/confirm') return reply(200, { pairingId: body.pairingId, state: 'paired', phone: { address: body.address, name: 'Phone' } });
      if (req.method === 'POST' && req.url === '/api/setup/pairing/cancel') return reply(200, { pairingId: body.pairingId, state: 'cancelled' });
      reply(404, { error: 'not found' });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new TelefonyAdminClient(port, 'private-token');
      await client.startPairing(180);
      await client.pairingStatus();
      await client.confirmPairing({ pairingId: 'pair-1', address: 'AA:BB:CC:DD:EE:FF', numericCode: '123456', accept: true });
      await client.cancelPairing('pair-1');

      expect(requests).toHaveLength(4);
      expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/setup/pairing', authorization: 'Bearer private-token', telefony: '1', body: { timeoutSeconds: 180 } });
      expect(requests[1]).toMatchObject({ method: 'GET', path: '/api/setup/pairing', authorization: 'Bearer private-token' });
      expect(requests[2]).toMatchObject({ method: 'POST', path: '/api/setup/pairing/confirm', telefony: '1', body: { pairingId: 'pair-1', numericCode: '123456', accept: true } });
      expect(requests[3]).toMatchObject({ method: 'POST', path: '/api/setup/pairing/cancel', telefony: '1', body: { pairingId: 'pair-1' } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('surfaces telefony HTTP errors and maps an unreachable loopback API to 503', async () => {
    const denied = new TelefonyAdminClient(30123, 'bad', vi.fn(async () => new Response('{"error":"bad token"}', { status: 401 })) as typeof fetch);
    await expect(denied.pairingStatus()).rejects.toMatchObject({ status: 401, message: 'bad token' });

    const offline = new TelefonyAdminClient(30123, 'token', vi.fn(async () => { throw new Error('connection refused'); }) as typeof fetch);
    await expect(offline.pairingStatus()).rejects.toMatchObject({ status: 503, message: expect.stringContaining('connection refused') });
  });
});
