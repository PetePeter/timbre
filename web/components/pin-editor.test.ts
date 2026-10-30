// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { AddressBookContact } from '../../src/contacts/contact.js';
import PinEditor from './PinEditor.vue';

const contact: AddressBookContact = {
  id: 'contact-1', name: 'Owner', numbers: ['+61412345678'], group: '', trusted: true, isUser: true,
};

describe('PinEditor validation', () => {
  it('shows the PIN rule, blocks a short PIN, and accepts six digits', async () => {
    const wrapper = mount(PinEditor, { props: { contact, busy: false } });
    const input = wrapper.get('input[aria-label="Caller PIN"]');

    expect(wrapper.text()).toContain('PIN must contain at least six digits.');
    await input.setValue('12345');
    expect(wrapper.find('[role="alert"]').text()).toBe('PIN must contain at least six digits.');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('save')).toBeUndefined();

    await input.setValue('123456');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('save')).toEqual([['123456']]);
  });

  it('shows and copies the phonebook line after the PIN save succeeds', async () => {
    let copied = '';
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { copied = value; } },
    });

    try {
      const wrapper = mount(PinEditor, { props: { contact, busy: false, lineNumber: '+61 (400) 000-000' } });
      await wrapper.get('input[aria-label="Caller PIN"]').setValue('123456');
      await wrapper.get('form').trigger('submit');
      expect(wrapper.find('.pin-dial-string').exists()).toBe(false);

      await wrapper.setProps({ busy: true });
      await wrapper.setProps({
        contact: { ...contact, pinSet: true, pinNeedsReentry: false },
        busy: false,
      });
      expect(wrapper.get('.pin-dial-string code').text()).toBe('+61400000000,,123456#');
      expect(wrapper.text()).toContain('30 seconds');
      expect(wrapper.text()).toContain('waits for you to tap');

      await wrapper.get('button[aria-label="Copy caller PIN dial string"]').trigger('click');
      expect(copied).toBe('+61400000000,,123456#');
      expect(wrapper.text()).toContain('Copied');
    } finally {
      if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('labels the sample line number as an example', async () => {
    const wrapper = mount(PinEditor, { props: { contact, busy: false } });
    await wrapper.get('input[aria-label="Caller PIN"]').setValue('123456');
    await wrapper.get('form').trigger('submit');
    await wrapper.setProps({ busy: true });
    await wrapper.setProps({ contact: { ...contact, pinSet: true, pinNeedsReentry: false }, busy: false });

    expect(wrapper.get('.pin-dial-string code').text()).toBe('+61400000000,,123456#');
    expect(wrapper.text()).toContain('Example only');
    expect(wrapper.text()).toContain('Replace +61400000000 with this phone’s number');
  });
});
