// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { createMemoryHistory } from 'vue-router';
import { defaultConfig } from '../src/config/timbre-config.js';
import App from './App.vue';
import { createAppRouter } from './router';

describe('Log page search', () => {
  let wrapper: VueWrapper | undefined;
  let requests: string[];

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.unstubAllGlobals();
  });

  it('submits a search for the selected phone and displays highlighted results', async () => {
    const config = defaultConfig();
    config.phones[0].name = 'Home';
    const phoneId = config.phones[0].id;
    requests = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/config') return Response.json(config);
      if (url === '/api/status') return Response.json({ phones: [] });
      if (url.startsWith(`/api/phones/${phoneId}/records?`)) return Response.json({ items: [], nextCursor: null });
      if (url === `/api/phones/${phoneId}/search?q=needle`) return Response.json({
        status: 'ready',
        items: [{ id: 'sms-1', kind: 'sms', occurredAt: '2026-10-29T10:00:00.000Z', contact: 'Jordan', snippet: 'hello needle there' }],
      });
      throw new Error(`Unexpected request: ${url}`);
    });

    const router = createAppRouter(createMemoryHistory());
    await router.push('/log');
    await router.isReady();
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
    await flushPromises();

    await wrapper.get('[aria-label="Search calls and texts"]').setValue('needle');
    await wrapper.findAll('button').find((button) => button.text() === 'Search')!.trigger('click');
    await flushPromises();

    expect(requests).toContain(`/api/phones/${phoneId}/search?q=needle`);
    expect(wrapper.get('.search-results').text()).toContain('hello needle there');
    expect(wrapper.get('.search-results mark').text()).toBe('needle');
  });
});
