// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { createMemoryHistory } from 'vue-router';
import { defaultConfig } from '../src/config/timbre-config.js';
import type { RecordSummary } from '../src/records/event-types.js';
import App from './App.vue';
import { createAppRouter } from './router';
import { localDateRangeToUtc } from './record-date-range';

describe('Unified call and text log', () => {
  let wrapper: VueWrapper | undefined;
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

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
    const unconfirmed = record('unconfirmed-sms', 'sms', 'outbound', 'Alex');
    unconfirmed.action = 'sms.out';
    unconfirmed.events = [{ eventId: 'checked', interactionId: unconfirmed.id, kind: 'sms', type: 'policy.evaluated', occurredAt: now, details: { allowed: true } }];
    const homeRecords = [record('in-call', 'call', 'inbound', 'Alex'), record('out-sms', 'sms', 'outbound', 'Alex'), unconfirmed, record('unknown-call', 'call', undefined, 'Riley'), record('tool-only', 'system', 'inbound', 'Agent')];
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
    expect(log.findAll('.log-row')).toHaveLength(6);
    expect(log.text()).toContain('Unconfirmed');
    expect(log.text()).toMatch(/\d{2}:\d{2}:\d{2}/);
    for (const label of ['Incoming call · Alex', 'Outgoing SMS · Alex', 'Call · Riley', 'Outgoing call · Sam', 'Incoming SMS · Sam']) expect(log.text()).toContain(label);
    expect(log.text()).not.toContain('Agent tool finished');
    await log.findAll('.log-row').find((row) => row.text().includes('Incoming call'))!.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('Agent tool finished');
  });

  it('offers to save an unknown number and links it to the People form', async () => {
    const config = defaultConfig();
    const phone = config.phones[0];
    const now = new Date().toISOString();
    const call = (id: string, from: string): RecordSummary => ({
      id, kind: 'call', direction: 'inbound', from, contact: 'Unknown caller', occurredAt: now, lastEventAt: now, action: 'call.ended', hasConference: false, blocked: false,
      events: [{ eventId: `${id}-start`, interactionId: id, kind: 'call', type: 'call.started', occurredAt: now, details: { direction: 'inbound' } }],
    });
    const records = [call('stranger', '+61409998877'), call('friend', '+61400000001')];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/config') return Response.json(config);
      if (url === '/api/status') return Response.json({ phones: [] });
      if (url === `/api/phones/${phone.id}/contacts`) return Response.json([{ id: 'c1', name: 'Jordan', numbers: ['+61400000001'], group: 'family', trusted: true, isUser: false, pinSet: false }]);
      if (url.startsWith(`/api/phones/${phone.id}/records?`)) return Response.json({ items: records, nextCursor: null });
      const match = url.match(/\/records\/([^/?]+)$/);
      if (match) return Response.json(records.find((item) => item.id === match[1]));
      return Response.json([]);
    });
    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    await router.isReady();
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
    await flushPromises();
    const links = wrapper.findAll('.log-add');
    expect(links).toHaveLength(1);
    expect(links[0].attributes('aria-label')).toBe('Add +61409998877 to contacts');
    expect(wrapper.get('.unified-log').text()).toContain('Jordan');
    await links[0].trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/people');
  });
  it('applies date presets to the activity request and keeps the custom range', async () => {
    const previousTimeZone = process.env.TZ;
    process.env.TZ = 'Australia/Sydney';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 5, 0, 0));
    try {
      const config = defaultConfig();
      const phone = config.phones[0];
      const requests: { from: string | null; to: string | null }[] = [];
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/config') return Response.json(config);
        if (url === '/api/status') return Response.json({ phones: [] });
        if (url === '/api/phones/' + phone.id + '/contacts') return Response.json([]);
        if (url.startsWith('/api/phones/' + phone.id + '/records?')) {
          const params = new URL(url, 'http://localhost').searchParams;
          requests.push({ from: params.get('from'), to: params.get('to') });
          return Response.json({ items: [], nextCursor: null });
        }
        throw new Error('Unexpected request: ' + url);
      });
      const router = createAppRouter(createMemoryHistory());
      await router.push('/');
      await router.isReady();
      wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
      await flushPromises();
      const log = wrapper.get('.unified-log');
      const cases = [
        ['Today', '2026-10-05', '2026-10-05'],
        ['Yesterday', '2026-10-04', '2026-10-04'],
        ['7 days', '2026-09-29', '2026-10-05'],
        ['30 days', '2026-09-06', '2026-10-05'],
      ] as const;

      for (const [label, fromDate, toDate] of cases) {
        const button = log.findAll('button').find((item) => item.text().trim() === label);
        expect(button, label + ' preset button').toBeDefined();
        const before = requests.length;
        await button!.trigger('click');
        await flushPromises();

        expect((log.get('input[aria-label="Start date"]').element as HTMLInputElement).value).toBe(fromDate);
        expect((log.get('input[aria-label="End date"]').element as HTMLInputElement).value).toBe(toDate);
        expect(requests.length).toBeGreaterThan(before);
        expect(requests.at(-1)).toEqual(localDateRangeToUtc(fromDate, toDate));
      }

      await log.get('input[aria-label="Start date"]').setValue('2026-09-10');
      await log.get('input[aria-label="End date"]').setValue('2026-09-11');
      await log.findAll('button').find((item) => item.text().trim() === 'Apply')!.trigger('click');
      await flushPromises();
      expect(requests.at(-1)).toEqual(localDateRangeToUtc('2026-09-10', '2026-09-11'));
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimeZone;
    }
  });
});
