// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { api } from './api';
import ContactNumberInput from './components/ContactNumberInput.vue';
import OwnerSmsForm from './components/OwnerSmsForm.vue';

const ButtonStub = {
  props: { label: String, type: { type: String, default: 'button' }, disabled: Boolean, loading: Boolean },
  emits: ['click'],
  template: '<button :type="type" :disabled="disabled" @click="$emit(\'click\', $event)">{{ label }}</button>',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OwnerSmsForm', () => {
  it('resolves a contact name and sends a policy-checked SMS', async () => {
    const loadContacts = vi.spyOn(api, 'contacts').mockResolvedValue([
      { id: 'jordan', name: 'Jordan Lee', numbers: ['+61412345678'], group: 'Family', trusted: true, isUser: true },
    ]);
    const send = vi.spyOn(api, 'sendOwnerSms').mockResolvedValue({ sent: true });
    const wrapper = mount(OwnerSmsForm, {
      props: { active: true, phoneId: 'phone-1', phoneName: 'Desk' },
      global: { stubs: { Button: ButtonStub } },
    });
    await flushPromises();
    expect(loadContacts).toHaveBeenCalledWith('phone-1');
    expect(wrapper.findComponent(ContactNumberInput).props('contacts')).toHaveLength(1);

    await wrapper.get('input[name="to"]').setValue('Jordan');
    await wrapper.get('button[role="option"]').trigger('click');
    await wrapper.get('textarea[name="text"]').setValue('Hello, Jordan.');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(send).toHaveBeenCalledWith('phone-1', { to: '+61412345678', text: 'Hello, Jordan.' });
    expect(wrapper.text()).toContain('SMS sent.');
    wrapper.unmount();
  });

  it('blocks a missing message and reports a policy refusal', async () => {
    vi.spyOn(api, 'contacts').mockResolvedValue([]);
    const send = vi.spyOn(api, 'sendOwnerSms').mockResolvedValue({ sent: false, reason: 'SMS is disabled for this contact.' });
    const wrapper = mount(OwnerSmsForm, {
      props: { active: true, phoneId: 'phone-1', phoneName: 'Desk' },
      global: { stubs: { Button: ButtonStub } },
    });
    await flushPromises();

    await wrapper.get('input[name="to"]').setValue('+61412345678');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(send).not.toHaveBeenCalled();

    await wrapper.get('textarea[name="text"]').setValue('Hello');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(send).toHaveBeenCalledWith('phone-1', { to: '+61412345678', text: 'Hello' });
    expect(wrapper.text()).toContain('SMS is disabled for this contact.');
    wrapper.unmount();
  });
});
