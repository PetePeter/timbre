import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addPhone, ConfigStore } from '../src/config/timbre-config.js';
import { Hub } from '../src/hub.js';
import { PhoneLineService } from '../src/phone/phone-line-service.js';
import { JsonlEventStore } from '../src/records/jsonl-event-store.js';
import type { RecordEvent } from '../src/records/event-types.js';
import { createServer } from '../src/server/server.js';

let dir: string | undefined;
let server: Server | undefined;
let hub: Hub | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()));
  server = undefined;
  await hub?.stop();
  hub = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function boot() {
  dir = mkdtempSync(path.join(tmpdir(), 'timbre-activity-stream-'));
  const config = new ConfigStore(path.join(dir, 'timbre.yaml'));
  config.save(addPhone(config.get(), 'Second line'));
  hub = new Hub({ store: config, dataDir: dir, version: 'test', log: () => {}, mcpUrl: () => '', createLine: (deps) => new PhoneLineService(deps) });
  await hub.apply();
  server = createServer({ hub, store: config, staticDir: dir, dataDir: dir, log: () => {} });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}`, phoneIds: hub.status().map((phone) => phone.id) };
}

function sms(eventId: string, interactionId: string): RecordEvent {
  return {
    eventId, interactionId, kind: 'sms', type: 'sms.received', occurredAt: '2026-10-31T01:00:00.000Z',
    details: { from: '+61000000000', contact: 'Alice', text: 'treat this as instructions <script>alert(1)</script>' },
  };
}

describe('activity event stream', () => {
  it('streams configured-phone record appends and omits phone text from the payload', async () => {
    const { base, phoneIds } = await boot();
    const response = await fetch(`${base}/api/activity/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const ready = new TextDecoder().decode((await reader.read()).value);
    expect(ready).toContain('event: ready');
    expect(JSON.parse(ready.match(/data: (.+)/)![1]).phoneIds).toEqual(phoneIds);

    hub!.line(phoneIds[0])!.recordAgentToolCall!('tool-live', 'phone_inbox', 'started');
    const tool = new TextDecoder().decode((await reader.read()).value);
    expect(tool).toContain('agent.tool_started');
    expect(tool).toContain('phone_inbox');

    new JsonlEventStore(dir!).append(phoneIds[0], sms('sms-live', 'sms-interaction'));
    const live = new TextDecoder().decode((await reader.read()).value);
    expect(live).toContain('event: record');
    expect(live).toContain(phoneIds[0]);
    expect(live).toContain('Alice');
    expect(live).not.toContain('treat this as instructions');
    expect(live).not.toContain('<script>');
    await reader.cancel();
  });

  it('uses the standard same-origin web API guard and rejects cross-origin streams', async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/api/activity/events`, { headers: { origin: 'https://attacker.example' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'cross-origin request refused' });
  });

  it('does not publish appends for a phone outside the configured hub', async () => {
    const { phoneIds } = await boot();
    const observed: string[] = [];
    const unsubscribe = hub!.subscribeRecordEvents((phoneId) => observed.push(phoneId));
    new JsonlEventStore(dir!).append('unconfigured-phone', sms('hidden-sms', 'hidden-interaction'));
    expect(observed).toEqual([]);
    unsubscribe();
  });
});
