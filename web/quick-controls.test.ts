// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { createMemoryHistory } from 'vue-router';
import { defaultConfig } from '../src/config/timbre-config.js';
import App from './App.vue';
import { createAppRouter } from './router';

describe('QuickControls', () => {
  let wrapper: VueWrapper | undefined;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.unstubAllGlobals();
  });

  it('saves each selected phone override immediately through the config API', async () => {
    const config = defaultConfig();
    config.phones[0].line.screening.acceptPrivate = false;
    const saved: ReturnType<typeof defaultConfig>[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url === '/api/status') return Response.json({ phones: [] });
      if (url === '/api/config' && options?.method === 'PUT') {
        const next = JSON.parse(options.body as string);
        saved.push(next);
        return Response.json(next);
      }
      if (url === '/api/config') return Response.json(config);
      throw new Error(`Unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    await router.isReady();
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
    await flushPromises();

    const choose = async (control: string, option: string) => {
      const button = wrapper!.get(`[aria-label="${control}"]`).findAll('button').find((item) => item.text().trim() === option);
      expect(button, `${control} option ${option}`).toBeDefined();
      await button!.trigger('click');
      await flushPromises();
    };

    await choose('Inbound mode', 'Busy');
    await choose('Unknown callers', 'Block');
    await choose('Private numbers', 'Allow');

    expect(saved).toHaveLength(3);
    expect(saved[0].phones[0].line.inboundMode).toBe('busy');
    expect(saved[1].phones[0].line.screening.unknownCallers).toBe('block');
    expect(saved[2].phones[0].line.screening.acceptPrivate).toBe(true);
    expect(wrapper!.get('.quick-controls .pill.sky').text()).toBe('Local model');
    expect(wrapper!.text()).not.toContain('Sample spend');
    expect(wrapper!.text()).not.toContain('Preview');
  });
});
