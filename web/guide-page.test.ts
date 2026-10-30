// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { createMemoryHistory } from 'vue-router';
import { defaultConfig } from '../src/config/timbre-config.js';
import App from './App.vue';
import { createAppRouter } from './router';

describe('Guide page', () => {
  let wrapper: VueWrapper | undefined;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.unstubAllGlobals();
  });

  it('shows live setup status and opens the pairing wizard from the checklist', async () => {
    const config = defaultConfig();
    const phone = config.phones[0]!;
    config.telefony.executable = 'C:/telefony/telefony-app.exe';
    phone.line.transport = 'usb:10D7:B012';
    let dongleScans = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/config') return Response.json(config);
      if (url === '/api/status') return Response.json({ phones: [{
        id: phone.id, name: phone.name, llm: '', agentKind: 'api', agentProblem: '',
        line: { enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' },
      }] });
      if (url === `/api/phones/${phone.id}/contacts`) return Response.json([]);
      if (url === '/api/app-tokens') return Response.json({ items: [] });
      if (url === '/api/phone-setup/dongles') {
        dongleScans += 1;
        return Response.json({ dongles: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const router = createAppRouter(createMemoryHistory());
    await router.push('/guide');
    await router.isReady();
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
    await flushPromises();

    expect(wrapper.get('main h1').text()).toBe('Guide');
    expect(wrapper.find('[data-nav="desktop"] a[href="/guide"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-guide-step]')).toHaveLength(16);
    expect(wrapper.get('[data-guide-step="1"] .guide-status').text()).toBe('Done');
    expect(wrapper.get('[data-guide-step="2"] .guide-status').text()).toBe('Not done');
    const agentGuide = wrapper.get('[aria-labelledby="agent-guide-title"]');
    expect(agentGuide.text()).toContain('How agents talk to Timbre');
    expect(agentGuide.text()).toContain('OpenAI-compatible API model');
    expect(agentGuide.text()).toContain('/mcp/{phoneId}');
    expect(agentGuide.get('a[href="/settings"]').text()).toContain('Connected apps');

    await wrapper.get('[data-guide-step="1"] .guide-step-action').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.path).toBe('/phones');
    expect(dongleScans).toBe(1);
  });
});
