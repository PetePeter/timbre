// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { createMemoryHistory } from 'vue-router';
import { addPhone, defaultConfig } from '../src/config/timbre-config.js';
import App from './App.vue';
import { createAppRouter } from './router';
import type { AddressBookContact } from '../src/contacts/contact.js';

describe('People page', () => {
  let wrapper: VueWrapper | undefined;
  let books: Record<string, AddressBookContact[]>;
  let requests: Array<{ method: string; url: string }>;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.unstubAllGlobals();
  });

  async function open(path = '/people') {
    const config = addPhone(defaultConfig(), 'Work');
    config.phones[0].name = 'Home';
    const [home, work] = config.phones;
    books = {
      [home.id]: [
        { id: 'home-contact', name: 'Jordan Lee', numbers: ['+61412345678'], group: 'Family', trusted: true, isUser: true },
        { id: 'work-contact-home', name: 'Alex Morgan', numbers: ['+61401234567'], group: 'Work', trusted: false, isUser: false },
      ],
      [work.id]: [{ id: 'work-contact', name: 'Alex Morgan', numbers: ['+61401234567'], group: 'Work', trusted: false, isUser: false }],
    };
    requests = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      const method = options?.method ?? 'GET';
      requests.push({ method, url });
      if (url === '/api/config') return Response.json(structuredClone(config));
      if (url === '/api/status') return Response.json({ phones: [] });
      const route = /^\/api\/phones\/([^/]+)\/contacts(?:\/([^/]+))?$/.exec(url);
      if (!route) throw new Error(`Unexpected request: ${method} ${url}`);
      const [, phoneId, contactId] = route;
      const contacts = books[phoneId] ?? [];
      if (method === 'GET' && !contactId) return Response.json(contacts);
      if (method === 'POST' && !contactId) {
        const contact = { ...JSON.parse(options?.body as string), id: `new-${contacts.length + 1}` } as AddressBookContact;
        books[phoneId] = [...contacts, contact];
        return Response.json(contact, { status: 201 });
      }
      if (method === 'PUT' && contactId) {
        const contact = { ...JSON.parse(options?.body as string), id: contactId } as AddressBookContact;
        books[phoneId] = contacts.map((item) => item.id === contactId ? contact : item);
        return Response.json(contact);
      }
      if (method === 'DELETE' && contactId) {
        books[phoneId] = contacts.filter((item) => item.id !== contactId);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('confirm', () => true);
    const router = createAppRouter(createMemoryHistory());
    await router.push(path);
    await router.isReady();
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
    await flushPromises();
    return { router, home, work };
  }

  it('loads by selected phone and supports add, edit, and delete', async () => {
    const { home, work } = await open();
    expect(wrapper!.get('main').text()).toContain('Jordan Lee');
    expect(requests.some((request) => request.url === `/api/phones/${home.id}/contacts`)).toBe(true);

    await wrapper!.findAll('.phone-chip').find((chip) => chip.text().includes('Work'))!.trigger('click');
    await flushPromises();
    expect(wrapper!.get('main').text()).toContain('Alex Morgan');
    expect(wrapper!.get('main').text()).not.toContain('Jordan Lee');
    expect(requests.some((request) => request.url === `/api/phones/${work.id}/contacts`)).toBe(true);

    await wrapper!.get('[aria-label="Add contact"]').trigger('click');
    await wrapper!.get('input[aria-label="Name"]').setValue('Riley Chen');
    await wrapper!.get('textarea[aria-label="Phone numbers"]').setValue('0412 345 678');
    await wrapper!.get('input[aria-label="Group"]').setValue('Family');
    await wrapper!.get('input[aria-label="Trusted"]').setValue(true);
    await wrapper!.get('input[aria-label="User"]').setValue(true);
    await wrapper!.get('input[aria-label="Transfer target"]').setValue(true);
    await wrapper!.get('input[aria-label="Default transfer"]').setValue(true);
    await wrapper!.get('button[aria-label="Save contact"]').trigger('click');
    await flushPromises();
    expect(books[work.id].some((contact) => contact.name === 'Riley Chen' && contact.trusted && contact.isUser
      && contact.transferTarget === true && contact.defaultTransfer === true)).toBe(true);
    expect(wrapper!.get('main').text()).toContain('Riley Chen');

    await wrapper!.get('button[aria-label="Edit Riley Chen"]').trigger('click');
    await wrapper!.get('input[aria-label="Name"]').setValue('Riley');
    expect((wrapper!.get('input[aria-label="Transfer target"]').element as HTMLInputElement).checked).toBe(true);
    expect((wrapper!.get('input[aria-label="Default transfer"]').element as HTMLInputElement).checked).toBe(true);
    await wrapper!.get('button[aria-label="Save contact"]').trigger('click');
    await flushPromises();
    expect(books[work.id].some((contact) => contact.name === 'Riley')).toBe(true);

    await wrapper!.get('button[aria-label="Delete Riley"]').trigger('click');
    await flushPromises();
    expect(books[work.id].some((contact) => contact.name === 'Riley')).toBe(false);
  });

  it('edits call summary preferences for users and keeps them on reload', async () => {
    const { home, work } = await open();

    await wrapper!.get('button[aria-label="Edit Jordan Lee"]').trigger('click');
    const missed = wrapper!.find('input[aria-label="Missed calls"]');
    expect(missed.exists()).toBe(true);
    await missed.setValue(true);
    await wrapper!.get('button[aria-label="Save contact"]').trigger('click');
    await flushPromises();
    expect(books[home.id][0]?.summaryNotifications).toEqual(['missed']);

    await wrapper!.get('button[aria-label="Edit Jordan Lee"]').trigger('click');
    expect((wrapper!.get('input[aria-label="Missed calls"]').element as HTMLInputElement).checked).toBe(true);

    await wrapper!.findAll('.phone-chip').find((chip) => chip.text().includes('Work'))!.trigger('click');
    await flushPromises();
    await wrapper!.get('button[aria-label="Edit Alex Morgan"]').trigger('click');
    expect(wrapper!.find('input[aria-label="Missed calls"]').exists()).toBe(false);
  });

  it('keeps the number from a log link while the phone and contacts load', async () => {
    await open('/people?add=%2B61409998877');
    expect(wrapper!.get('h2').text()).toBe('Add contact');
    expect((wrapper!.get('textarea[aria-label="Phone numbers"]').element as HTMLTextAreaElement).value)
      .toBe('+61409998877');
  });

  it('filters contacts by status, group, and search without losing the real empty state', async () => {
    await open();
    const filterButtons = () => wrapper!.findAll('.contact-filters button');
    expect(filterButtons().map((button) => button.text())).toEqual(['All', 'Trusted', 'You', 'Family', 'Work']);

    await wrapper!.get('[aria-label="Search contacts"]').setValue('work');
    expect(wrapper!.get('main').text()).toContain('Alex Morgan');
    expect(wrapper!.get('main').text()).not.toContain('Jordan Lee');

    await wrapper!.get('[aria-label="Search contacts"]').setValue('');
    await filterButtons().find((button) => button.text() === 'Trusted')!.trigger('click');
    expect(wrapper!.get('main').text()).toContain('Jordan Lee');
    expect(wrapper!.get('main').text()).not.toContain('Alex Morgan');

    await filterButtons().find((button) => button.text() === 'Family')!.trigger('click');
    expect(wrapper!.get('main').text()).toContain('Jordan Lee');

    await wrapper!.get('[aria-label="Search contacts"]').setValue('no such person');
    expect(wrapper!.get('main').text()).toContain('No matches');
    expect(wrapper!.get('main').text()).not.toContain('No contacts yet');
  });
});
