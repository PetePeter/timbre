// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { defaultConfig } from '../src/config/timbre-config.js';
import PhonePanel from './PhonePanel.vue';

describe('PhonePanel contact settings', () => {
  let wrapper: ReturnType<typeof mount> | undefined;
  let overlayHost: HTMLElement | undefined;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    overlayHost?.remove();
    overlayHost = undefined;
    vi.unstubAllGlobals();
  });

  it('does not expose the legacy line contact editor', async () => {
    const phone = defaultConfig().phones[0];
    phone.line.contacts.push({
      label: 'Legacy caller', pattern: '+61491570156', role: 'trusted', callIn: true, callOut: false,
      smsIn: true, smsOut: false, conf: false, pin: '', messages: false,
    });
    overlayHost = document.createElement('div');
    overlayHost.id = 'timbre-overlay-host';
    document.body.append(overlayHost);
    wrapper = mount(PhonePanel, {
      props: { phone, llms: [], busy: false, dirty: false },
      attachTo: document.body,
      global: { plugins: [[PrimeVue, { unstyled: true }]] },
    });

    await wrapper.get('[aria-expanded]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[aria-label="Contact 1 name"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Contact 1 number pattern"]').exists()).toBe(false);
    expect(wrapper.findAll('button').some((button) => button.text().trim() === '+ Contact')).toBe(false);
    expect(wrapper.findAll('button').some((button) => button.text().trim() === 'Remove phone')).toBe(true);
  });

  it('keeps the Bluetooth default aligned with a renamed phone and exposes it for editing', async () => {
    const config = defaultConfig();
    const phone = config.phones[0];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/phone-setup/descriptor') return Response.json({ setupVersion: 1, fields: [] });
      if (url === '/api/voices') return Response.json([]);
      if (url === '/api/phone-setup/dongles') return Response.json({ dongles: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    overlayHost = document.createElement('div');
    overlayHost.id = 'timbre-overlay-host';
    document.body.append(overlayHost);
    wrapper = mount(PhonePanel, {
      props: { phone, config, llms: [], busy: false, dirty: false },
      attachTo: document.body,
      global: { plugins: [[PrimeVue, { unstyled: true }]] },
    });

    await wrapper.get('[aria-expanded]').trigger('click');
    await flushPromises();
    await wrapper.get('input[aria-label="Phone name"]').setValue('Office');
    expect(phone.line.deviceName).toBe('Timbre - Office');
    expect((wrapper.get('input[aria-label$="Bluetooth device name"]').element as HTMLInputElement).value)
      .toBe('Timbre - Office');
  });

  it('edits the existing phone speech recognition model', async () => {
    const config = defaultConfig();
    const phone = config.phones[0];
    phone.line.voice.sttModel = 'tiny.en';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/phone-setup/descriptor') return Response.json({
        provider: 'telefony-app', providerVersion: '1.2.3', setupVersion: 1,
        fields: [
          { key: 'voice.tts', label: 'Text-to-speech mode', type: 'enum', default: 'auto', choices: ['auto', 'piper', 'sapi', 'none'] },
          { key: 'voice.piper_model', label: 'Piper model path', type: 'path', default: null },
          { key: 'voice.sapi_voice', label: 'SAPI voice', type: 'string', default: null },
          { key: 'voice.stt_model', label: 'Speech-to-text model (Whisper)', type: 'string', default: 'small.en', choices: ['none'] },
        ],
      });
      if (url === '/api/voices') return Response.json([
        { id: 'sapi:hazel', type: 'sapi', source: 'sapi', label: 'Microsoft Hazel Desktop', sapiVoice: 'Microsoft Hazel Desktop' },
      ]);
      if (url === '/api/phone-setup/dongles') return Response.json({ dongles: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    overlayHost = document.createElement('div');
    overlayHost.id = 'timbre-overlay-host';
    document.body.append(overlayHost);
    wrapper = mount(PhonePanel, {
      props: { phone, config, llms: [], busy: false, dirty: false },
      attachTo: document.body,
      global: { plugins: [[PrimeVue, { unstyled: true }]] },
    });

    await wrapper.get('[aria-expanded]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Text-to-speech mode');
    expect(wrapper.text()).toContain('Piper model path');
    expect(wrapper.text()).toContain('SAPI voice');
    expect(wrapper.text()).toContain('Speech-to-text model (Whisper)');
    const input = wrapper.get('input[aria-label$="Speech recognition model"]');
    expect((input.element as HTMLInputElement).value).toBe('tiny.en');
    await input.setValue('small.en');
    expect(phone.line.voice.sttModel).toBe('small.en');
  });
});
