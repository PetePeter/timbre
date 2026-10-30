// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defaultConfig } from '../src/config/timbre-config.js';
import AppTokensSection from './components/AppTokensSection.vue';

afterEach(() => vi.unstubAllGlobals());

describe('Connected apps', () => {
  it('creates a scoped token, shows its secret once, and revokes by metadata id', async () => {
    const config = defaultConfig();
    config.phones[0].name = 'Desk';
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/app-tokens' && options?.method === 'POST') return Response.json({
        token: 'tm_one-time-secret',
        app: { id: 'app-1', name: 'Calendar', createdAt: '2026-10-30T00:00:00.000Z', phoneIds: ['*'], actions: ['records.read', 'sms.send'] },
      }, { status: 201 });
      if (url === '/api/app-tokens/app-1' && options?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url === '/api/app-tokens') return Response.json({ items: [
        { id: 'app-1', name: 'Calendar', createdAt: '2026-10-30T00:00:00.000Z', phoneIds: ['*'], actions: ['records.read', 'sms.send'] },
      ] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(AppTokensSection, { props: { phones: config.phones } });
    await flushPromises();
    await wrapper.get('input[aria-label="Token name"]').setValue('Calendar');
    await wrapper.get('input[aria-label="Allow Send SMS"]').setValue(true);
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    const createCall = fetchMock.mock.calls.find(([url, options]) => url === '/api/app-tokens' && options?.method === 'POST');
    expect(JSON.parse(createCall?.[1]?.body as string)).toMatchObject({ name: 'Calendar', phoneIds: ['*'], actions: ['records.read', 'sms.send'] });
    expect(wrapper.get('[aria-label="New app token"]').text()).toBe('tm_one-time-secret');
    expect(wrapper.text()).toContain('All phones');
    expect(wrapper.text()).toContain('records.read, sms.send');

    await wrapper.get('button[aria-label="Revoke Calendar"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith('/api/app-tokens/app-1', expect.objectContaining({ method: 'DELETE' }));
    await wrapper.findAll('button').find((button) => button.text() === 'Hide token')!.trigger('click');
    expect(wrapper.find('[aria-label="New app token"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
