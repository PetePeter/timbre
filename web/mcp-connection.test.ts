// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PhoneMcpConnection from './components/PhoneMcpConnection.vue';

afterEach(() => vi.unstubAllGlobals());

describe('PhoneMcpConnection', () => {
  it('loads the phone credential and keeps token-bearing snippets masked until revealed', async () => {
    const fetchMock = vi.fn(async () => Response.json({ token: 'phone-secret-123' }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const wrapper = mount(PhoneMcpConnection, { props: { phoneId: 'desk-phone' } });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith('/api/phones/desk-phone/mcp-connection', expect.any(Object));
    expect(wrapper.get('[aria-label="MCP bearer token"]').text()).toBe('••••••••');
    expect(wrapper.text()).not.toContain('phone-secret-123');
    expect(wrapper.text()).toContain(`${window.location.origin}/mcp/desk-phone`);

    await wrapper.get('button[aria-label="Copy Codex · ~/.codex/config.toml setup"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith([
      '[mcp_servers.timbre-desk-phone]',
      `url = "${window.location.origin}/mcp/desk-phone"`,
      'http_headers = { Authorization = "Bearer phone-secret-123" }',
    ].join('\n'));
    expect(wrapper.text()).not.toContain('phone-secret-123');

    await wrapper.get('button[aria-label="Reveal MCP token"]').trigger('click');
    expect(wrapper.get('[aria-label="MCP bearer token"]').text()).toBe('phone-secret-123');
    expect(wrapper.text()).toContain('Bearer phone-secret-123');
    wrapper.unmount();
  });
});
