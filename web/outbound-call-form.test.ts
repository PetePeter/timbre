// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import OutboundCallForm from './components/OutboundCallForm.vue';

afterEach(() => vi.unstubAllGlobals());

describe('OutboundCallForm', () => {
  it('loads phones and submits to the owner call route', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      const method = options?.method ?? 'GET';
      const body = options?.body ? JSON.parse(options.body as string) : undefined;
      requests.push({ url, method, body });
      if (url === '/api/status') return Response.json({ phones: [{ id: 'phone-1', name: 'Desk' }] });
      if (url === '/api/phones/phone-1/calls') return Response.json({ interactionId: 'call-1', state: 'dialing' }, { status: 202 });
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const wrapper = mount(OutboundCallForm);
    await flushPromises();

    await wrapper.get('input[name="to"]').setValue('02 9876 5432');
    await wrapper.get('textarea[name="task"]').setValue('Book a table for two.');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(requests).toContainEqual({ url: '/api/phones/phone-1/calls', method: 'POST', body: { to: '02 9876 5432', task: 'Book a table for two.' } });
    expect(wrapper.text()).toContain('call-1');
    expect(wrapper.text()).toMatch(/call requested/i);
    wrapper.unmount();
  });

  it('shows server policy errors', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => String(input) === '/api/status'
      ? Response.json({ phones: [{ id: 'phone-1', name: 'Desk' }] })
      : new Response(JSON.stringify({ error: 'The phone line is busy.' }), { status: 409 }));
    const wrapper = mount(OutboundCallForm);
    await flushPromises();
    await wrapper.get('input[name="to"]').setValue('02 9876 5432');
    await wrapper.get('textarea[name="task"]').setValue('Book a table.');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('The phone line is busy.');
    wrapper.unmount();
  });

  it('selects a contact suggestion and submits the contact number', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      const method = options?.method ?? 'GET';
      const body = options?.body ? JSON.parse(options.body as string) : undefined;
      requests.push({ url, method, body });
      if (url === '/api/status') return Response.json({ phones: [{ id: 'phone-1', name: 'Desk' }] });
      if (url === '/api/phones/phone-1/contacts') return Response.json([
        { id: 'alex', name: 'Alex Morgan', numbers: ['+61401234567'], group: 'Work', trusted: false, isUser: false },
      ]);
      if (url === '/api/phones/phone-1/calls') return Response.json({ interactionId: 'call-2', state: 'dialing' }, { status: 202 });
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const wrapper = mount(OutboundCallForm);
    await flushPromises();

    await wrapper.get('input[name="to"]').setValue('Alex');
    await wrapper.get('button[role="option"]').trigger('click');
    expect((wrapper.get('input[name="to"]').element as HTMLInputElement).value).toBe('+61401234567');
    await wrapper.get('textarea[name="task"]').setValue('Book a table.');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(requests).toContainEqual({ url: '/api/phones/phone-1/calls', method: 'POST', body: { to: '+61401234567', task: 'Book a table.' } });
    wrapper.unmount();
  });
});
