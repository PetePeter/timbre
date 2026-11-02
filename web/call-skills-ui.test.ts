// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ConfigStore } from '../src/config/timbre-config.js';
import { Hub, type HubLine } from '../src/hub.js';
import { createServer } from '../src/server/server.js';
import OutboundCallForm from './components/OutboundCallForm.vue';

let close: (() => Promise<void>) | null = null;
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await close?.();
  close = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('saved call skill UI integration', () => {
  it('fills a saved skill and starts it through the real server', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'timbre-call-skills-ui-'));
    dirs.push(dir);
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    const calls: Array<{ to: string; task: string }> = [];
    const makeLine = () => ({
      async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
      getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
      isCallHolder: () => false, async sendToSession() { return { sent: true }; },
      async hangup() {}, async inbox() { return []; }, async startCallAgent() { return {}; }, async verifyCaller() { return ''; },
      async startOwnerCallAgent(request: { to: string; task: string }) { calls.push(request); return { interactionId: 'skill-call', state: 'dialing' }; },
      isCallerVerified: () => false, async transfer() { return false; }, enterMessageMode() { return false; }, reportCallOutcome() { return false; },
      async sendSms() { return { sent: true }; },
    }) as unknown as HubLine;
    const hub = new Hub({ store, dataDir: dir, version: 'test', log: () => {}, mcpUrl: () => '', createLine: makeLine });
    await hub.apply();
    const server = createServer({ hub, store, staticDir: path.join(dir, 'none'), dataDir: dir, log: () => {} });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    close = async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await hub.stop();
    };

    vi.stubGlobal('fetch', (input: RequestInfo | URL, options?: RequestInit) => fetchServer(input, options, base));
    const wrapper = mount(OutboundCallForm);
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('select[name="callSkill"]').exists()).toBe(true));
    const skill = store.get().callSkills.find((item) => item.id === 'book-appointment')!;

    await wrapper.get('select[name="callSkill"]').setValue(skill.id);
    await wrapper.get('input[name="number"]').setValue('0298765432');
    await wrapper.get('input[name="business"]').setValue('Midas');
    await wrapper.get('input[name="service"]').setValue('oil change');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(wrapper.text()).toContain('skill-call'));

    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('0298765432');
    expect(calls[0].task).toContain('Skill: Book an appointment');
    expect(calls[0].task).toContain('"business": "Midas"');
    wrapper.unmount();
  });
});

/** Adapts the browser's relative API URLs to an actual HTTP request against the test server. */
function fetchServer(input: RequestInfo | URL, options: RequestInit | undefined, base: string): Promise<Response> {
  const url = new URL(String(input), base);
  const headers: Record<string, string> = {};
  new Headers(options?.headers).forEach((value, key) => { headers[key] = value; });
  headers.origin = base;
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options?.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode ?? 500,
        headers: Object.fromEntries(Object.entries(res.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      })));
    });
    req.on('error', reject);
    if (typeof options?.body === 'string') req.write(options.body);
    req.end();
  });
}
