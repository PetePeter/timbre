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
  let config: ReturnType<typeof defaultConfig>;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    saved = [];
    config = defaultConfig();
    config.phones[0].name = 'Home';
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      if (url === '/api/status') return Response.json({ phones: [] });
      if (url === '/api/voices') return Response.json([
        { id: 'piper:old', type: 'piper', source: 'stock', label: 'Old Piper', modelPath: 'C:/voices/old.onnx' },
        { id: 'sapi:hazel', type: 'sapi', source: 'sapi', label: 'Microsoft Hazel Desktop', sapiVoice: 'Microsoft Hazel Desktop' },
      ]);
      if (url === '/api/config' && options?.method === 'PUT') {
        const next = JSON.parse(options.body as string);
        saved.push(next);
        const returned = structuredClone(next);
        for (const phone of returned.phones) for (const server of phone.mcpServers ?? []) {
          for (const values of [server.headers, server.env]) if (values) {
            for (const [key, value] of Object.entries(values)) if (value) values[key] = '••••••';
          }
        }
        return Response.json(returned);
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

  it('saves the selected phone voice and API persona with the agent settings', async () => {
    await open('/agent');
    await wrapper!.get('[aria-label="Phone voice"]').trigger('click');
    await flushPromises();
    const voiceOption = Array.from(document.querySelectorAll('[role="option"]')).find((option) => option.textContent?.includes('Microsoft Hazel Desktop'))!;
    voiceOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();
    const field = (labelText: string) => wrapper!.findAll('label').find((label) => label.text().includes(labelText))!;
    await field('Assistant name').get('input').setValue('Ava');
    await field('Tone').get('input').setValue('Warm');
    await field('Instructions').get('textarea').setValue('Keep answers short.');
    await wrapper!.get('[data-action="save"]').trigger('click');
    await flushPromises();
    expect(saved[0].phones[0].line.voice).toMatchObject({ tts: 'sapi', sapiVoice: 'Microsoft Hazel Desktop' });
    expect(saved[0].phones[0].line.persona).toMatchObject({ name: 'Ava', tone: 'Warm', instructions: 'Keep answers short.' });
  });

  it('returns to Automatic when clearing a selected Piper model', async () => {
    config.phones[0].line.voice.tts = 'piper';
    config.phones[0].line.voice.piperModel = 'C:/voices/old.onnx';
    await open('/agent');

    const selector = wrapper!.get('[aria-label="Phone voice"]');
    expect(selector.text()).toContain('Old Piper');
    await selector.trigger('click');
    await flushPromises();
    const automatic = Array.from(document.querySelectorAll('[role="option"]')).find((option) => option.textContent?.includes('Automatic'))!;
    automatic.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();

    expect(wrapper!.get('[aria-label="Phone voice"]').text()).toContain('Automatic');
    await wrapper!.get('[data-action="save"]').trigger('click');
    await flushPromises();
    expect(saved[0].phones[0].line.voice).toMatchObject({ tts: 'auto', piperModel: '' });
  });

  it('keeps persona prompt settings off CLI agents', async () => {
    const id = config.llms[0].id;
    config.llms[0] = { id, name: 'CLI', kind: 'cli', command: 'claude', args: [], cwd: '.' };
    await open('/agent');
    expect(wrapper!.text()).toContain('Persona prompt settings are available when this phone uses an API or Claude Code agent.');
    expect(wrapper!.findAll('h2').some((heading) => heading.text() === 'Phone persona')).toBe(false);
  });

  it('adds Claude Code with the restricted preset controls', async () => {
    await open('/agent');
    await wrapper!.findAll('button').find((button) => button.text() === '+ Claude Code')!.trigger('click');

    expect(wrapper!.get('[aria-label="Claude Code preset"]').text()).toContain('Timbre phone tools are enabled by default.');
    await wrapper!.get('[data-action="save"]').trigger('click');
    await flushPromises();
    expect(saved[0].llms[1]).toMatchObject({
      kind: 'cli', preset: 'claude-code', command: 'claude', args: [], extraAllowedTools: [],
    });
  });

  it('shows phone persona settings for Claude Code and saves only curated extras', async () => {
    const id = config.llms[0].id;
    config.llms[0] = {
      id, name: 'Claude Code', kind: 'cli', command: 'claude', args: [], cwd: '', preset: 'claude-code', extraAllowedTools: [],
    };
    config.phones[0].llmId = id;
    await open('/agent');

    expect(wrapper!.findAll('h2').some((heading) => heading.text() === 'Phone persona')).toBe(true);
    expect(wrapper!.text()).toContain("These prompt settings apply to this phone's agent on the next call.");
    await wrapper!.get('input[aria-label="Allow Bash"]').setValue(true);
    await wrapper!.get('[data-action="save"]').trigger('click');
    await flushPromises();

    expect(saved[0].llms[0]).toMatchObject({ preset: 'claude-code', extraAllowedTools: ['Bash'] });
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

  it('edits API mode, daily token cap, and a per-phone MCP server in one save', async () => {
    const router = await open('/agent');
    await wrapper!.get('[aria-label="API model mode"]').trigger('click');
    await flushPromises();
    await wrapper!.findAll('[role="option"]').find((option) => option.text().includes('Full tools'))!.trigger('mousedown');
    const cap = wrapper!.get('input[aria-label="Daily token cap"]');
    await cap.setValue('12000');
    await cap.trigger('blur');

    await router.push('/phones');
    await flushPromises();
    await wrapper!.findAll('button').find((button) => button.text() === 'Settings')!.trigger('click');
    await wrapper!.get('[aria-label="Add MCP server"]').trigger('click');
    await wrapper!.get('[aria-label="MCP server 1 name"]').setValue('calendar');
    await wrapper!.get('[aria-label="MCP server 1 URL"]').setValue('https://mcp.example.test');
    await wrapper!.get('[aria-label="MCP server 1 allowed tools"]').setValue('search, create');
    await wrapper!.get('[aria-label="Add MCP header"]').trigger('click');
    await wrapper!.get('[aria-label="MCP header 1 name"]').setValue('Authorization');
    await wrapper!.get('[aria-label="MCP header 1 secret"]').setValue('Bearer new-secret');
    await wrapper!.get('[aria-label="Add MCP server"]').trigger('click');
    await wrapper!.get('[aria-label="MCP server 2 transport"]').trigger('click');
    await flushPromises();
    await wrapper!.findAll('[role="option"]').find((option) => option.text().includes('Command (stdio)'))!.trigger('mousedown');
    await wrapper!.get('[aria-label="MCP server 2 name"]').setValue('contacts');
    await wrapper!.get('[aria-label="MCP server 2 command"]').setValue('node');
    await wrapper!.get('[aria-label="MCP server 2 working folder"]').setValue('C:/mcp/contacts');
    const args = wrapper!.get('[aria-label="MCP server 2 arguments"]');
    await args.setValue('--config {mcpConfig}');
    await args.trigger('change');
    await wrapper!.get('[aria-label="Add MCP environment variable"]').trigger('click');
    await wrapper!.get('[aria-label="MCP environment variable 1 name"]').setValue('MCP_TOKEN');
    await wrapper!.get('[aria-label="MCP environment variable 1 secret"]').setValue('env-secret');
    expect((wrapper!.get('[aria-label="MCP environment variable 1 secret"]').element as HTMLInputElement).value).toBe('env-secret');

    await wrapper!.get('[data-action="save"]').trigger('click');
    await flushPromises();

    expect(saved).toHaveLength(1);
    expect(saved[0].llms[0]).toMatchObject({ mode: 'full', dailyTokenLimit: 12000 });
    expect(saved[0].phones[0].mcpServers[0]).toMatchObject({
      name: 'calendar', url: 'https://mcp.example.test',
      allowedTools: ['search', 'create'], headers: { Authorization: 'Bearer new-secret' },
    });
    expect(saved[0].phones[0].mcpServers[1]).toMatchObject({
      name: 'contacts', command: 'node', args: ['--config', '{mcpConfig}'], cwd: 'C:/mcp/contacts',
      env: { MCP_TOKEN: 'env-secret' }, allowedTools: [],
    });
    expect((wrapper!.get('[aria-label="MCP header 1 secret"]').element as HTMLInputElement).value).toBe('');
    expect((wrapper!.get('[aria-label="MCP environment variable 1 secret"]').element as HTMLInputElement).value).toBe('');
  });
});
