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
});
