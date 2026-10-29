// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { createMemoryHistory } from 'vue-router';
import { defaultConfig } from '../src/config/timbre-config';
import App from './App.vue';
import { createAppRouter } from './router';

describe('Timbre shell', () => {
  let wrapper: VueWrapper | undefined;
  let saved: ReturnType<typeof defaultConfig>[];

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    saved = [];
    const config = defaultConfig();
    config.phones[0].name = 'Home';
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      if (url === '/api/status') return Response.json({ phones: [] });
      if (url === '/api/config' && options?.method === 'PUT') {
        const next = JSON.parse(options.body as string);
        saved.push(next);
        return Response.json(next);
      }
      if (url === '/api/config') return Response.json(config);
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.unstubAllGlobals();
  });

  async function open(path = '/') {
    const router = createAppRouter(createMemoryHistory());
    await router.push(path);
    await router.isReady();
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
    await flushPromises();
    return router;
  }

  it('navigates every desktop tab and exposes the other destinations from mobile More', async () => {
    const router = await open();
    for (const [path, title] of [['/log', 'Log'], ['/people', 'People'], ['/insights', 'Insights'], ['/agent', 'Agent'], ['/phones', 'Phones'], ['/settings', 'Settings'], ['/', 'Switchboard']]) {
      await wrapper!.get(`[data-nav="desktop"] a[href="${path}"]`).trigger('click');
      await flushPromises();
      expect(router.currentRoute.value.path).toBe(path);
      expect(wrapper!.get('main h1').text()).toBe(title);
      expect(wrapper!.get(`[data-nav="desktop"] a[href="${path}"]`).attributes('aria-current')).toBe('page');
    }
    await wrapper!.get('[data-nav="mobile"] a[href="/more"]').trigger('click');
    await flushPromises();
    await wrapper!.get('main a[href="/settings"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/settings');
  });

  it('restores a theme choice after the app is recreated', async () => {
    await open();
    await wrapper!.get('button[aria-label="Switch to dark theme"]').trigger('click');
    expect(wrapper!.get('.app-root').classes()).toContain('timbre-dark');
    expect(document.documentElement.classList.contains('timbre-dark')).toBe(false);
    expect(localStorage.getItem('timbre.theme')).toBe('dark');
    wrapper!.unmount();
    await open();
    expect(wrapper!.find('button[aria-label="Switch to light theme"]').exists()).toBe(true);
    await wrapper!.get('button[aria-label="Switch to light theme"]').trigger('click');
    expect(wrapper!.get('.app-root').classes()).not.toContain('timbre-dark');
    expect(localStorage.getItem('timbre.theme')).toBe('light');
  });

  it('moves keyboard focus to the content without leaving the current hash route', async () => {
    const router = await open('/settings');
    await wrapper!.get('.skip-link').trigger('click');
    expect(document.activeElement?.id).toBe('main-content');
    expect(router.currentRoute.value.path).toBe('/settings');
  });

  it('renders an open PrimeVue Select overlay inside the themed app root', async () => {
    await open('/phones');
    await wrapper!.get('button[aria-label="Switch to dark theme"]').trigger('click');
    await wrapper!.findAll('button').find((button) => button.text() === 'Settings')!.trigger('click');
    await wrapper!.get('[aria-label="Answered by"]').trigger('click');
    await flushPromises();

    const listbox = document.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(listbox?.closest('.app-root.timbre-dark')).not.toBeNull();
    expect(listbox?.closest('#timbre-overlay-host')).not.toBeNull();
  });

  it('keeps edits across routes, saves through the existing API and discards later edits', async () => {
    const router = await open('/settings');
    await wrapper!.get('input[aria-label="Web port"]').setValue('7800');
    await wrapper!.get('input[aria-label="Web port"]').trigger('blur');
    await router.push('/agent');
    await flushPromises();
    await router.push('/settings');
    await flushPromises();
    expect((wrapper!.get('input[aria-label="Web port"]').element as HTMLInputElement).value).toBe('7800');
    await wrapper!.get('[data-action="save"]').trigger('click');
    await flushPromises();
    expect(saved).toHaveLength(1);
    expect(saved[0].web.port).toBe(7800);
    expect(saved[0].phones[0].name).toBe('Home');
    await wrapper!.get('input[aria-label="Web port"]').setValue('7900');
    await wrapper!.get('input[aria-label="Web port"]').trigger('blur');
    await wrapper!.get('[data-action="discard"]').trigger('click');
    await flushPromises();
    expect((wrapper!.get('input[aria-label="Web port"]').element as HTMLInputElement).value).toBe('7800');
    expect(wrapper!.find('[data-action="save"]').exists()).toBe(false);
  });

  it('adds and saves an agent when the LAN browser has no secure-context UUID API', async () => {
    vi.stubGlobal('crypto', {});
    await open('/agent');
    await wrapper!.findAll('button').find((button) => button.text() === '+ API model')!.trigger('click');
    expect(wrapper!.findAll('main fieldset')).toHaveLength(2);
    await wrapper!.get('[data-action="save"]').trigger('click');
    await flushPromises();
    expect(saved).toHaveLength(1);
    expect(new Set(saved[0].llms.map((llm) => llm.id)).size).toBe(2);
    expect(saved[0].llms[1].kind).toBe('api');
  });

  it('allows spaces while typing CLI arguments and commits the argument list on change', async () => {
    await open('/agent');
    await wrapper!.findAll('button').find((button) => button.text() === '+ CLI in a terminal')!.trigger('click');
    const field = wrapper!.findAll('label').find((label) => label.text().includes('Arguments:'))!.get('input');
    (field.element as HTMLInputElement).value = '--verbose ';
    await field.trigger('input');
    expect((field.element as HTMLInputElement).value).toBe('--verbose ');
    (field.element as HTMLInputElement).value = '--verbose --mcp-config {mcpConfig}';
    await field.trigger('input');
    await field.trigger('change');
    await wrapper!.get('[data-action="save"]').trigger('click');
    await flushPromises();
    expect(saved[0].llms[1]).toMatchObject({ kind: 'cli', args: ['--verbose', '--mcp-config', '{mcpConfig}'] });
  });
});
