// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { api } from './api';
import TestCallDialog from './components/TestCallDialog.vue';

class FakeEventSource {
  static latest: FakeEventSource | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onerror: ((event: Event) => unknown) | null = null;

  constructor(readonly url: string) { FakeEventSource.latest = this; }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const wrapped = (event: MessageEvent<string>) => {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    };
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }

  close(): void {}

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const DialogStub = defineComponent({
  props: { visible: { type: Boolean, default: false } },
  emits: ['update:visible'],
  template: '<div v-if="visible"><slot /><button type="button" data-testid="dismiss" @click="$emit(\'update:visible\', false)">Dismiss</button></div>',
});
const ButtonStub = defineComponent({
  props: { label: String, type: { type: String, default: 'button' }, disabled: Boolean, loading: Boolean },
  emits: ['click'],
  template: '<button :type="type" :disabled="disabled" @click="$emit(\'click\', $event)">{{ label }}</button>',
});
const InputStub = defineComponent({ props: { modelValue: String }, template: '<input :value="modelValue">' });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.latest = null;
});

describe('TestCallDialog', () => {
  it('resets to the start form when reopened after an ended call', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-call');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(api, 'startTestCall').mockResolvedValue({ callId: 'test-call-1' });
    vi.spyOn(api, 'sendTestCallUtterance').mockResolvedValue({ ok: true });
    vi.spyOn(api, 'endTestCall').mockResolvedValue({ ok: true });

    const wrapper = mount(TestCallDialog, {
      props: { visible: true, phoneId: 'phone-1', phoneName: 'Desk' },
      global: { stubs: { Dialog: DialogStub, Button: ButtonStub, InputText: InputStub, Textarea: InputStub } },
    });
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    FakeEventSource.latest!.emit('message', { speaker: 'caller', text: 'Hello' });
    FakeEventSource.latest!.emit('state', { state: 'ended' });
    await flushPromises();
    expect(wrapper.text()).toContain('Hello');
    expect(wrapper.text()).toContain('Download transcript');

    wrapper.findComponent(DialogStub).vm.$emit('update:visible', false);
    await flushPromises();
    await wrapper.setProps({ visible: false });
    await wrapper.setProps({ visible: true });
    await flushPromises();

    expect(wrapper.get('form').text()).toContain('Start test call');
    expect(wrapper.text()).not.toContain('Hello');
    wrapper.unmount();
  });
});
