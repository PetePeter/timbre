// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
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
    const phone = defaultConfig().phones[0];
    overlayHost = document.createElement('div');
    overlayHost.id = 'timbre-overlay-host';
    document.body.append(overlayHost);
    wrapper = mount(PhonePanel, {
      props: { phone, llms: [], busy: false, dirty: false },
      attachTo: document.body,
      global: { plugins: [[PrimeVue, { unstyled: true }]] },
    });

    await wrapper.get('[aria-expanded]').trigger('click');
    await wrapper.get('input[aria-label="Phone name"]').setValue('Office');
    expect(phone.line.deviceName).toBe('Timbre - Office');
    expect((wrapper.get('input[aria-label="Bluetooth device name"]').element as HTMLInputElement).value)
      .toBe('Timbre - Office');
  });

  it('edits the existing phone speech recognition model', async () => {
    const phone = defaultConfig().phones[0];
    phone.line.voice.sttModel = 'tiny.en';
    overlayHost = document.createElement('div');
    overlayHost.id = 'timbre-overlay-host';
    document.body.append(overlayHost);
    wrapper = mount(PhonePanel, {
      props: { phone, llms: [], busy: false, dirty: false },
      attachTo: document.body,
      global: { plugins: [[PrimeVue, { unstyled: true }]] },
    });

    await wrapper.get('[aria-expanded]').trigger('click');
    const input = wrapper.get('input[aria-label="Speech recognition model"]');
    expect((input.element as HTMLInputElement).value).toBe('tiny.en');
    await input.setValue('small.en');
    expect(phone.line.voice.sttModel).toBe('small.en');
  });
});
