// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { api } from './api';
import ContactNumberInput from './components/ContactNumberInput.vue';
import TestSmsDialog from './components/TestSmsDialog.vue';

const DialogStub = defineComponent({
  props: { visible: { type: Boolean, default: false } },
  emits: ['update:visible'],
  template: '<div v-if="visible"><slot /></div>',
});

const ButtonStub = defineComponent({
  props: { label: String, type: { type: String, default: 'button' }, disabled: Boolean, loading: Boolean },
  emits: ['click'],
  template: '<button :type="type" :disabled="disabled" @click="$emit(\'click\', $event)">{{ label }}</button>',
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TestSmsDialog', () => {
  it('selects a contact number, sends on submit, and shows success', async () => {
    const loadContacts = vi.spyOn(api, 'contacts').mockResolvedValue([
      { id: 'jordan', name: 'Jordan Lee', numbers: ['+61412345678'], group: 'Family', trusted: true, isUser: true },
    ]);
    const send = vi.spyOn(api, 'sendOwnerSms').mockResolvedValue({ sent: true });
    const wrapper = mount(TestSmsDialog, {
      props: { visible: true, phoneId: 'phone-1', phoneName: 'Desk' },
      global: { stubs: { Dialog: DialogStub, Button: ButtonStub } },
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

  it('shows a policy refusal and does not send invalid input', async () => {
    vi.spyOn(api, 'contacts').mockResolvedValue([]);
    const send = vi.spyOn(api, 'sendOwnerSms').mockResolvedValue({ sent: false, reason: 'SMS is disabled for this contact.' });
    const wrapper = mount(TestSmsDialog, {
      props: { visible: true, phoneId: 'phone-1', phoneName: 'Desk' },
      global: { stubs: { Dialog: DialogStub, Button: ButtonStub } },
    });
    await flushPromises();

    await wrapper.get('input[name="to"]').setValue('not a phone number');
    await wrapper.get('textarea[name="text"]').setValue('Hello');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(send).not.toHaveBeenCalled();

    await wrapper.get('input[name="to"]').setValue('+61412345678');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(send).toHaveBeenCalledWith('phone-1', { to: '+61412345678', text: 'Hello' });
    expect(wrapper.text()).toContain('SMS is disabled for this contact.');
    wrapper.unmount();
  });
});
