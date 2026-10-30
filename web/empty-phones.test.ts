// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { createMemoryHistory } from 'vue-router';
import { defaultConfig } from '../src/config/timbre-config.js';
import App from './App.vue';
import { createAppRouter } from './router';

describe('pages with no phones configured', () => {
  let wrapper: VueWrapper | undefined;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.unstubAllGlobals();
  });

  async function open(path: string): Promise<VueWrapper> {
    const config = { ...defaultConfig(), phones: [] };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/config') return Response.json(config);
      if (url === '/api/status') return Response.json({ phones: [] });
      if (url === '/api/app-tokens') return Response.json({ items: [] });
      if (url === '/api/phone-setup/dongles') return Response.json({ dongles: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const router = createAppRouter(createMemoryHistory());
    await router.push(path);
    await router.isReady();
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
    await flushPromises();
    return wrapper;
  }

  it('shows the phone setup action and opens the existing wizard', async () => {
    const page = await open('/phones');

    expect(page.text()).toContain('No phones connected');
    await page.findAll('button').find((button) => button.text().trim() === 'Set up a phone')!.trigger('click');
    await flushPromises();

    expect(document.body.textContent).toContain('Choose a Bluetooth dongle');
  });

  it('shows an actionable empty state instead of a phone checklist', async () => {
    const page = await open('/guide');

    expect(page.text()).toContain('Set up a phone to see your setup checklist.');
    expect(page.find('[aria-label="Phone setup checklist"]').exists()).toBe(false);
  });

  it('explains that a phone is needed for the log and live views', async () => {
    const log = await open('/log');
    expect(log.text()).toContain('Set up a phone to see calls and texts.');
    log.unmount();
    wrapper = undefined;

    const live = await open('/live');
    expect(live.text()).toContain('Set up a phone before using live call controls.');
  });
});
