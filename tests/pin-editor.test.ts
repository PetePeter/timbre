// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PinEditor from '../web/components/PinEditor.vue';
import type { AddressBookContact } from '../src/contacts/contact.js';

const contact: AddressBookContact = {
  id: 'maya', name: 'Maya', numbers: ['+61491570156'], group: 'Family', trusted: true, isUser: false,
  pinSet: false, pinNeedsReentry: true,
};

describe('PinEditor', () => {
  it('shows the migration status and emits only the replacement PIN', async () => {
    const wrapper = mount(PinEditor, { props: { contact, busy: false } });
    expect(wrapper.text()).toContain('PIN needs re-entry');
    await wrapper.get('input').setValue('135790');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('save')).toEqual([['135790']]);
  });

  it('rejects short PINs and offers an explicit clear action', async () => {
    const wrapper = mount(PinEditor, { props: { contact: { ...contact, pinSet: true, pinNeedsReentry: false }, busy: false } });
    await wrapper.get('input').setValue('12345');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('save')).toBeUndefined();
    expect(wrapper.text()).toContain('PIN must contain at least six digits.');
    await wrapper.get('button[aria-label="Clear caller PIN"]').trigger('click');
    expect(wrapper.emitted('save')).toEqual([['']]);
  });
});
