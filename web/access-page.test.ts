// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { createMemoryHistory } from 'vue-router';
import { defaultConfig } from '../src/config/timbre-config.js';
import type { AddressBookContact } from '../src/contacts/contact.js';
import { isBlocked, resolvePhoneLineConfig } from '../src/phone/phone-config.js';
import App from './App.vue';
import { createAppRouter } from './router';

describe('Access page', () => {
  let wrapper: VueWrapper | undefined;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.unstubAllGlobals();
  });

  it('edits the selected phone screening rules and saves them', async () => {
    const config = defaultConfig();
    const phone = config.phones[0];
    phone.line.screening.block = [{ kind: 'contact', value: 'maya' }];
    phone.line.blocklist = ['^\\+61491570156$'];
    phone.line.contactRules.push({
      contactId: 'maya', role: 'blocked', callIn: false, callOut: false, smsIn: false,
      smsOut: false, conf: false, pin: '', messages: false,
    });
    const contacts: AddressBookContact[] = [
      { id: 'maya', name: 'Address book contact', numbers: ['+61491570156', '+61400000001'], group: 'Family', trusted: true, isUser: false },
    ];
    let saved: typeof config | undefined;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url === '/api/status') return Response.json({ phones: [] });
      if (url === '/api/config' && options?.method === 'PUT') {
        saved = JSON.parse(options.body as string);
        return Response.json(saved);
      }
      if (url === '/api/config') return Response.json(config);
      if (url === `/api/phones/${phone.id}/contacts`) return Response.json(contacts);
      throw new Error(`Unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const router = createAppRouter(createMemoryHistory());
    await router.push('/access');
    await router.isReady();
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
    await flushPromises();

    await wrapper.get('[aria-label="Accept private numbers"]').setValue(true);
    await wrapper.get('[aria-label="Choose entry type"]').trigger('click');
    await flushPromises();
    const numberOption = wrapper.findAll('[role="option"]').find((option) => option.text().includes('Number'));
    expect(numberOption).toBeDefined();
    await numberOption!.trigger('mousedown');
    await flushPromises();
    expect(wrapper.find('[aria-label="Exact number or prefix"]').exists()).toBe(true);
    await wrapper.get('[aria-label="Exact number or prefix"]').setValue('+6129000*');
    await wrapper.get('[aria-label="Add to allow list"]').trigger('click');
    await wrapper.get('[aria-label="Block list"] [aria-label="Remove rule"]').trigger('click');
    await wrapper.get('[aria-label="Save access settings"]').trigger('click');
    await flushPromises();

    expect(saved?.phones[0].line.screening).toEqual({
      allow: [{ kind: 'number', value: '+6129000*' }], block: [], acceptPrivate: true,
    });
    expect(saved?.phones[0].line.blocklist).toEqual([]);
    expect(saved?.phones[0].line.contactRules.some((rule) => rule.role === 'blocked')).toBe(false);
    expect(isBlocked('+61491570156', resolvePhoneLineConfig(saved!.phones[0].line))).toBe(false);
    expect(wrapper.get('main').text()).toContain('+6129000*');
  });

  it('adds a group handling rule and saves it with the selected phone', async () => {
    const config = defaultConfig();
    const phone = config.phones[0];
    const contacts: AddressBookContact[] = [
      { id: 'maya', name: 'Maya', numbers: ['+61491570156'], group: 'Family', trusted: true, isUser: false },
    ];
    let saved: typeof config | undefined;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url === '/api/status') return Response.json({ phones: [] });
      if (url === '/api/config' && options?.method === 'PUT') {
        saved = JSON.parse(options.body as string);
        return Response.json(saved);
      }
      if (url === '/api/config') return Response.json(config);
      if (url === `/api/phones/${phone.id}/contacts`) return Response.json(contacts);
      throw new Error(`Unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const router = createAppRouter(createMemoryHistory());
    await router.push('/access');
    await router.isReady();
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
    await flushPromises();

    const choose = async (label: string, text: string) => {
      await wrapper!.get(`[aria-label="${label}"]`).trigger('click');
      await flushPromises();
      const option = wrapper!.findAll('[role="option"]').find((item) => item.text().includes(text));
      expect(option).toBeDefined();
      await option!.trigger('mousedown');
      await flushPromises();
    };
    await choose('Handling target type', 'Group');
    await choose('Handling group', 'Family');
    await choose('Handling action', 'Always put through');
    await wrapper.get('[aria-label="Add handling rule"]').trigger('click');
    await wrapper.get('[aria-label="Rule greeting"]').setValue('Hi {caller}, connecting you now.');
    await wrapper.get('[aria-label="Rule instructions"]').setValue('Connect this caller to the owner.');
    await wrapper.get('[aria-label="Save access settings"]').trigger('click');
    await flushPromises();

    expect(saved?.phones[0].line.inboundHandling.rules).toEqual([{
      kind: 'group', value: 'Family', action: 'always-through',
      greeting: 'Hi {caller}, connecting you now.', instructions: 'Connect this caller to the owner.',
    }]);
  });
});
