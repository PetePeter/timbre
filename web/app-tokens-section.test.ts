// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { defaultConfig } from '../src/config/timbre-config.js';
import AppTokensSection from './components/AppTokensSection.vue';

const wrappers: Array<ReturnType<typeof mount>> = [];

beforeEach(() => {
  document.body.innerHTML = '<div id="timbre-overlay-host"></div>';
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

function dialogButton(label: string): HTMLButtonElement {
  const button = dialog()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing dialog button: ${label}`);
  return button;
}

describe('Connected apps', () => {
  it('shows one-time copy actions in a dialog and clears the token when closed', async () => {
    const config = defaultConfig();
    config.phones[0].name = 'Desk';
    const created = [
      {
        token: 'tm_one-time-secret',
        app: { id: 'app-1', name: 'Calendar', createdAt: '2026-10-30T00:00:00.000Z', phoneIds: ['*'], actions: ['sms.list', 'sms.send'] },
      },
      {
        token: 'tm_second-secret',
        app: { id: 'app-2', name: 'Reports', createdAt: '2026-10-30T00:00:00.000Z', phoneIds: ['*'], actions: ['sms.list'] },
      },
    ];
    let createCount = 0;
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/app-tokens' && options?.method === 'POST') {
        return Response.json(created[createCount++], { status: 201 });
      }
      if (url === '/api/app-tokens/app-1' && options?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url === '/api/app-tokens') return Response.json({ items: created.slice(0, createCount).map(({ app }) => app) });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const wrapper = mount(AppTokensSection, {
      props: { phones: config.phones },
      attachTo: document.body,
      global: { plugins: [[PrimeVue, { unstyled: true }]] },
    });
    wrappers.push(wrapper);
    await flushPromises();
    expect(wrapper.get('h3').text()).toBe('Server apps that connect to Timbre');
    expect(wrapper.text()).toContain('Applies to all phones');

    await wrapper.get('input[aria-label="Token name"]').setValue('Calendar');
    await wrapper.get('input[aria-label="Allow Send SMS"]').setValue(true);
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    const createCall = fetchMock.mock.calls.find(([url, options]) => url === '/api/app-tokens' && options?.method === 'POST');
    expect(JSON.parse(createCall?.[1]?.body as string)).toMatchObject({ name: 'Calendar', phoneIds: ['*'], actions: ['sms.list', 'sms.send'] });
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Calendar');
    expect(dialogButton('Copy token')).toBeTruthy();
    expect(dialogButton('Copy Claude Code setup line')).toBeTruthy();
    expect(dialogButton('Copy Codex setup line')).toBeTruthy();
    expect(dialog()?.textContent).not.toContain('tm_one-time-secret');
    expect(wrapper.get('ul[aria-label="Connected app tokens"]').findAll('li')).toHaveLength(1);
    expect(wrapper.get('ul[aria-label="Connected app tokens"]').get('li').findAll('button')).toHaveLength(2);

    await dialogButton('Copy token').click();
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith('tm_one-time-secret');
    await dialogButton('Copy Claude Code setup line').click();
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith(
      `claude mcp add --scope user --transport http timbre ${window.location.origin}/mcp --header "Authorization: Bearer tm_one-time-secret"`,
    );
    await dialogButton('Copy Codex setup line').click();
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith(
      `[mcp_servers.timbre]\nurl = "${window.location.origin}/mcp"\nhttp_headers = { Authorization = "Bearer tm_one-time-secret" }`,
    );

    await dialogButton('Close token details').click();
    await flushPromises();
    expect(document.body.textContent).not.toContain('tm_one-time-secret');
    expect(document.body.querySelector('button[aria-label="Copy token"]')).toBeNull();

    await wrapper.get('input[aria-label="Token name"]').setValue('Reports');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(dialog()?.textContent).toContain('Reports');
    expect(dialog()?.textContent).not.toContain('tm_one-time-secret');
    await dialogButton('Copy token').click();
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith('tm_second-secret');

    const rows = wrapper.get('ul[aria-label="Connected app tokens"]').findAll('li');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.findAll('button').map((button) => button.attributes('aria-label')))).toEqual([
      ['Configure Calendar', 'Revoke Calendar'],
      ['Configure Reports', 'Revoke Reports'],
    ]);
    await wrapper.get('button[aria-label="Revoke Calendar"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith('/api/app-tokens/app-1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('configures a token in place without revealing a secret', async () => {
    const config = defaultConfig();
    config.phones[0].id = 'phone-a';
    const token = {
      id: 'app-config', name: 'Calendar', createdAt: '2026-10-30T00:00:00.000Z',
      phoneIds: ['phone-a'], actions: ['sms.list'],
    };
    let app = token;
    const saved = { body: null as { phoneIds: string[]; actions: string[] } | null };
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/app-tokens/app-config' && options?.method === 'PATCH') {
        saved.body = JSON.parse(options.body as string);
        app = { ...app, ...saved.body };
        return Response.json(app);
      }
      if (url === '/api/app-tokens') return Response.json({ items: [app] });
      throw new Error('Unexpected request: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(AppTokensSection, {
      props: { phones: config.phones },
      attachTo: document.body,
      global: { plugins: [[PrimeVue, { unstyled: true }]] },
    });
    wrappers.push(wrapper);
    await flushPromises();

    await wrapper.get('button[aria-label="Configure Calendar"]').trigger('click');
    await flushPromises();
    expect(dialog()?.textContent).toContain('Calendar');
    expect(dialog()?.querySelector('button[aria-label="Copy token"]')).toBeNull();
    expect(dialog()?.textContent).not.toContain('tm_');

    const select = dialog()?.querySelector('select') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    select!.value = '*';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    const checkbox = (label: string) => {
      const input = dialog()?.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]');
      if (!input) throw new Error('Missing dialog action: ' + label);
      input.click();
    };
    checkbox('Allow List and read SMS');
    checkbox('Allow Conference calls (needs Make calls)');
    const form = dialog()?.querySelector('form');
    expect(form).not.toBeNull();
    await form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(dialog()?.textContent).toContain('Conference calls need Make calls.');
    expect(fetchMock.mock.calls.some(([url, options]) => url === '/api/app-tokens/app-config' && options?.method === 'PATCH')).toBe(false);

    checkbox('Allow Make calls');
    await form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(saved.body).toMatchObject({ phoneIds: ['*'] });
    expect(saved.body?.actions).toEqual(expect.arrayContaining(['calls.make', 'calls.conference']));
    expect(fetchMock).toHaveBeenCalledWith('/api/app-tokens/app-config', expect.objectContaining({ method: 'PATCH' }));
    expect(dialog()).toBeNull();
    expect(document.body.textContent).not.toContain('tm_');
    const rows = wrapper.get('ul[aria-label="Connected app tokens"]').findAll('li');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain('All phones');
    expect(rows[0].findAll('button')).toHaveLength(2);
  });
});
