// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { createMemoryHistory } from 'vue-router';
import { defaultConfig } from '../src/config/timbre-config.js';
import type { RecordSummary } from '../src/records/event-types.js';
import App from './App.vue';
import { createAppRouter } from './router';

describe('Unified call and text log', () => {
  let wrapper: VueWrapper | undefined;
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); });

  it('shows four communication types across phones and keeps agent tool steps inside the call detail', async () => {
    const config = defaultConfig();
    const home = config.phones[0];
    home.name = 'Home';
    const work = { ...home, id: 'work-phone', name: 'Work' };
    config.phones.push(work);
    const now = new Date().toISOString();
    const record = (id: string, kind: 'call' | 'sms' | 'system', direction: 'inbound' | 'outbound' | undefined, contact: string): RecordSummary => ({
      id, kind, direction, contact, occurredAt: now, lastEventAt: now, action: kind === 'call' ? 'call.ended' : direction === 'inbound' ? 'sms.received' : 'sms.sent', hasConference: false, blocked: false,
      events: kind === 'call' ? [
        { eventId: `${id}-start`, interactionId: id, kind: 'call', type: 'call.started', occurredAt: now, details: { ...(direction ? { direction } : {}), contact } },
        { eventId: `${id}-tool`, interactionId: id, kind: 'system', type: 'agent.tool_finished', occurredAt: now, details: { toolName: 'verify_caller', outcome: 'completed' } },
        { eventId: `${id}-end`, interactionId: id, kind: 'call', type: 'call.ended', occurredAt: now, details: { durationSeconds: 42 } },
      ] : [{ eventId: `${id}-event`, interactionId: id, kind: 'sms', type: direction === 'inbound' ? 'sms.received' : 'sms.sent', occurredAt: now, details: { ...(direction ? { direction } : {}), contact } }],
    });
    const homeRecords = [record('in-call', 'call', 'inbound', 'Alex'), record('out-sms', 'sms', 'outbound', 'Alex'), record('unknown-call', 'call', undefined, 'Riley'), record('tool-only', 'system', 'inbound', 'Agent')];
    const workRecords = [record('out-call', 'call', 'outbound', 'Sam'), record('in-sms', 'sms', 'inbound', 'Sam')];
    const all = new Map([...homeRecords.map((item) => [`${home.id}:${item.id}`, item] as const), ...workRecords.map((item) => [`${work.id}:${item.id}`, item] as const)]);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/config') return Response.json(config);
      if (url === '/api/status') return Response.json({ phones: [] });
      if (url.startsWith(`/api/phones/${home.id}/records?`)) return Response.json({ items: homeRecords, nextCursor: null });
      if (url.startsWith(`/api/phones/${work.id}/records?`)) return Response.json({ items: workRecords, nextCursor: null });
      const match = url.match(/^\/api\/phones\/([^/]+)\/records\/([^/?]+)$/);
      if (match) return Response.json(all.get(`${match[1]}:${match[2]}`));
      throw new Error(`Unexpected request: ${url}`);
    });
    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    await router.isReady();
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
    await flushPromises();
    const log = wrapper.get('.unified-log');
    expect(log.findAll('.log-row')).toHaveLength(5);
    expect(log.text()).toMatch(/\d{2}:\d{2}:\d{2}/);
    for (const label of ['Incoming call · Alex', 'Outgoing SMS · Alex', 'Call · Riley', 'Outgoing call · Sam', 'Incoming SMS · Sam']) expect(log.text()).toContain(label);
    expect(log.text()).not.toContain('Agent tool finished');
    await log.findAll('.log-row').find((row) => row.text().includes('Incoming call'))!.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('Agent tool finished');
  });
});
