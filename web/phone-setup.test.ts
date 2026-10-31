// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { createMemoryHistory } from 'vue-router';
import { addPhone, defaultConfig, removePhone, type TimbreConfig } from '../src/config/timbre-config.js';
import type { PhoneStatus } from './api';
import PhonePanel from './PhonePanel.vue';
import App from './App.vue';
import PhoneSetupWizard from './components/PhoneSetupWizard.vue';
import { createAppRouter } from './router';

describe('phone setup wizard', () => {
  let wrapper: VueWrapper | undefined;
  let saved: TimbreConfig | null = null;
  let pairingId = '';
  let pairingAccepted = false;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    document.querySelectorAll('#timbre-overlay-host').forEach((host) => host.remove());
    vi.unstubAllGlobals();
  });

  it('renders the four steps and completes pairing against a fake dongle and telefony API', async () => {
    localStorage.clear();
    const initial = defaultConfig();
    initial.phones[0].name = 'Home';
    initial.telefony.executable = 'C:\\phap\\custom-server.exe';
    saved = structuredClone(initial);
    pairingId = '';
    pairingAccepted = false;
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      const method = options?.method ?? 'GET';
      requests.push({ url, method });
      const body = options?.body ? JSON.parse(options.body as string) : {};
      if (url === '/api/config' && method === 'GET') return Response.json(structuredClone(saved));
      if (url === '/api/config' && method === 'PUT') { saved = body; return Response.json(structuredClone(saved)); }
      if (url === '/api/status') return Response.json({ phones: [] });
      if (url === '/api/phone-setup/dongles') return Response.json({ dongles: [
        { id: '10D7:B012', name: 'USB Bluetooth Radio', driver: 'libusbK', probeAvailable: true },
      ] });
      if (url === '/api/phones' && method === 'POST') {
        saved = addPhone(saved!, body.name || 'New phone');
        return Response.json(structuredClone(saved));
      }
      const pairing = /^\/api\/phones\/([^/]+)\/setup\/pairing(?:\/(start|confirm|cancel))?$/.exec(url);
      if (pairing?.[2] === 'start') {
        pairingId = 'pair-1';
        pairingAccepted = false;
        const deviceName = saved!.phones.find((phone) => phone.id === pairing[1])!.line.deviceName;
        return Response.json({ pairingId, state: 'discoverable', deviceName, expiresAt: 'later' });
      }
      if (pairing && method === 'GET') return pairingAccepted
        ? Response.json({ pairingId, state: 'paired', phone: { address: 'AA:BB:CC:DD:EE:FF', name: 'Work mobile' } })
        : Response.json({ pairingId, state: 'awaiting-confirmation', phone: { address: 'AA:BB:CC:DD:EE:FF', name: 'Work mobile' }, numericCode: '123456' });
      if (pairing?.[2] === 'confirm') {
        pairingAccepted = true;
        return new Response(JSON.stringify({ error: 'Bond did not finish yet' }), { status: 504 });
      }
      if (pairing?.[2] === 'cancel') return Response.json({ pairingId, state: 'cancelled' });
      const remove = /^\/api\/phones\/([^/]+)$/.exec(url);
      if (remove && method === 'DELETE') { saved = removePhone(saved!, remove[1]); return Response.json(structuredClone(saved)); }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    const router = createAppRouter(createMemoryHistory());
    await router.push('/phones');
    await router.isReady();
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, [PrimeVue, { unstyled: true }]] } });
    await flushPromises();

    await wrapper.findAll('button').find((button) => button.text().includes('+ Add phone'))!.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('1. Dongle');
    expect(document.body.textContent).toContain('USB Bluetooth Radio');
    expect(document.querySelector('#timbre-overlay-host')?.textContent).toContain('Choose a Bluetooth dongle');
    await wrapper.get('input[type="radio"][value="10D7:B012"]').trigger('click');
    expect((wrapper.get('input[placeholder="Path to a PhAP server executable"]').element as HTMLInputElement).value).toBe('C:\\phap\\custom-server.exe');
    await wrapper.findAll('button').find((button) => button.text().includes('Scan again'))!.trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === 'Continue')!.trigger('click');
    await flushPromises();

    expect(document.body.textContent).toContain('2. Find phone');
    const firstDraftId = saved!.phones.at(-1)!.id;
    const inventoryCount = requests.filter((request) => request.url === '/api/phone-setup/dongles').length;
    await wrapper.findAll('button').find((button) => button.text() === 'Back')!.trigger('click');
    await flushPromises();
    expect(saved!.phones).toHaveLength(1);
    expect(requests).toContainEqual({ url: `/api/phones/${firstDraftId}`, method: 'DELETE' });
    expect(requests.filter((request) => request.url === '/api/phone-setup/dongles')).toHaveLength(inventoryCount + 1);
    await wrapper.findAll('button').find((button) => button.text() === 'Continue')!.trigger('click');
    await flushPromises();

    expect(document.body.textContent).toContain('2. Find phone');
    expect(document.body.textContent).toContain('choose Timbre - New phone');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await flushPromises();
    expect(document.body.textContent).toContain('Phone detected · tap to pair');
    expect(document.body.textContent).toContain('AA:BB:CC:DD:EE:FF');
    await wrapper.get('.detected-phone').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('Confirm the pairing code');
    expect(document.body.textContent).toContain('123456');

    await wrapper.findAll('button').find((button) => button.text().includes('Codes match'))!.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('Bond did not finish yet');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await flushPromises();
    expect(document.body.textContent).not.toContain('Bond did not finish yet');
    expect(document.body.textContent).toContain('Phone settings');
    expect(Array.from(document.body.querySelectorAll('a[href="/access"]')).some((link) => link.textContent?.includes('Access page'))).toBe(true);
    const phoneName = document.querySelector<HTMLInputElement>('input[aria-label="Phone name"]')!;
    phoneName.value = 'Work mobile';
    phoneName.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    expect((wrapper.get('input[aria-label="Bluetooth device name"]').element as HTMLInputElement).value)
      .toBe('Timbre - Work mobile');
    await wrapper.findAll('button').find((button) => button.text().includes('Finish setup'))!.trigger('click');
    await flushPromises();

    const created = saved!.phones[1];
    expect(created).toMatchObject({
      name: 'Work mobile',
      line: { enabled: true, transport: 'usb:10D7:B012+sco=2', deviceName: 'Timbre - Work mobile' },
    });
    expect(saved!.telefony.executable).toBe('C:\\phap\\custom-server.exe');
    expect(requests.some((request) => request.url.endsWith('/setup/pairing/start'))).toBe(true);
    expect(requests.some((request) => request.url.endsWith('/setup/pairing/confirm'))).toBe(true);
    expect(requests.some((request) => request.url === '/api/phone-setup/dongles' && request.method === 'POST')).toBe(true);
    expect(document.body.textContent).not.toContain('Confirm the pairing code');

    const phonesBeforePairAgain = saved!.phones.length;
    const pairAgain = wrapper.findAll('button').find((button) => button.text().trim().toLowerCase() === 'pair again');
    expect(pairAgain).toBeDefined();
    await pairAgain!.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('2. Find phone');
    expect(saved!.phones).toHaveLength(phonesBeforePairAgain);
    expect(requests.at(-1)?.url).toBe(`/api/phones/${created.id}/setup/pairing/start`);
    await wrapper.findAll('button').find((button) => button.text() === 'Cancel setup')!.trigger('click');
    await flushPromises();
    expect(saved!.phones).toHaveLength(phonesBeforePairAgain);
  });

  it('shows offline, online and no-dongle phone status chips', async () => {
    const config = defaultConfig();
    const phone = config.phones[0];
    const status = (process: PhoneStatus['line']['process'], line: PhoneStatus['line']['line'] = null): PhoneStatus => ({
      id: phone.id, name: phone.name, llm: 'Local model', agentKind: 'api', agentProblem: '',
      line: { enabled: true, process, pendingRestart: false, line, configPath: '' },
    });
    wrapper = mount(PhonePanel, { props: { phone, llms: config.llms, canRemove: true, busy: false, dirty: false }, global: { plugins: [[PrimeVue, { unstyled: true }]] } });
    expect(wrapper.get('.pill').text()).toBe('Offline');
    await wrapper.setProps({ status: status({ state: 'running', pid: 1, since: 0, restarts: 0 }, {
      connected: true, link: 'up', liveAudioAvailable: false, call: null, usage: { callsLastHour: 0, smsLastHour: 0 }, decisions: [],
    }) });
    expect(wrapper.get('.pill').text()).toBe('Online');
    await wrapper.setProps({ status: status({ state: 'failed', lastError: 'Bluetooth dongle not found: check USB' }) });
    expect(wrapper.get('.pill').text()).toBe('No dongle');
  });

  it('shows the actual bound driver and probe failure with Zadig steps', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input) === '/api/phone-setup/dongles') return Response.json({
        dongles: [{ id: '10D7:B012', name: 'general adapter', driver: 'other', driverService: 'USBSTOR', probeAvailable: false }],
        probeError: 'libusb: access denied',
        pnpError: 'WMI access denied',
      });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const portalHost = document.createElement('div');
    portalHost.id = 'timbre-overlay-host';
    document.body.append(portalHost);
    wrapper = mount(PhoneSetupWizard, {
      attachTo: document.body,
      props: {
        visible: true,
        config: defaultConfig(),
        llms: [],
        error: '',
        createDraft: async () => null,
        saveDraft: async () => true,
        discardDraft: async () => undefined,
      },
      global: { plugins: [[PrimeVue, { unstyled: true }]] },
    });
    await flushPromises();

    const dongleRadio = document.querySelector<HTMLInputElement>('input[type="radio"][value="10D7:B012"]');
    expect(dongleRadio).not.toBeNull();
    dongleRadio!.click();
    await flushPromises();
    expect(document.body.textContent).toContain('Telefony Bluetooth probe failed: libusb: access denied');
    expect(document.body.textContent).toContain('Windows driver lookup failed: WMI access denied');
    expect(document.body.textContent).toContain('Current driver: USBSTOR. Bumble needs WinUSB');
    expect(document.body.textContent).toContain('Options > List All Devices');
    expect(document.body.textContent).toContain('select WinUSB, then click Replace Driver');
    expect(document.body.textContent).toContain('To revert, open Device Manager');
  });
});
