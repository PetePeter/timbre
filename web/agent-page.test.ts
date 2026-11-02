// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, reactive } from 'vue';
import { mount } from '@vue/test-utils';
import AgentPage from './pages/AgentPage.vue';

const { getState } = vi.hoisted(() => ({ getState: vi.fn() }));
vi.mock('./app-state', () => ({ useAppState: () => getState() }));

const ButtonStub = defineComponent({
  props: { label: String, disabled: Boolean },
  emits: ['click'],
  template: '<button :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
});
const TestCallDialogStub = defineComponent({
  props: { visible: Boolean, phoneId: String, phoneName: String },
  template: '<div v-if="visible" data-testid="agent-simulation-dialog">{{ phoneName }}</div>',
});

function appState(call: { callId: string } | null = null) {
  return reactive({
    cfg: { llms: [], phones: [{ id: 'phone-2', name: 'Kitchen', llmId: 'llm-1', mcpServers: [] }] },
    selectedPhone: { id: 'phone-2', name: 'Kitchen', llmId: 'llm-1', mcpServers: [] },
    selectedStatus: { line: { line: { connected: true, call } } },
    busy: false,
    dirty: false,
    save: vi.fn(),
    addLlm: vi.fn(),
    removeLlm: vi.fn(),
  });
}

afterEach(() => {
  getState.mockReset();
});

describe('Agent page simulation', () => {
  it('opens a simulation for the selected connected phone', async () => {
    getState.mockReturnValue(appState());
    const wrapper = mount(AgentPage, {
      global: { stubs: { Button: ButtonStub, TestCallDialog: TestCallDialogStub, AppTokensSection: true } },
    });

    await wrapper.findAll('button').find((button) => button.text() === 'Agent simulation')!.trigger('click');

    expect(wrapper.text()).toContain('Kitchen');
    expect(wrapper.get('[data-testid="agent-simulation-dialog"]').text()).toBe('Kitchen');
    expect(wrapper.findComponent(TestCallDialogStub).props()).toMatchObject({ visible: true, phoneId: 'phone-2', phoneName: 'Kitchen' });
    wrapper.unmount();
  });

  it('disables simulation while the selected phone is disconnected or on a call', () => {
    const disconnected = appState();
    disconnected.selectedStatus.line.line.connected = false;
    getState.mockReturnValue(disconnected);
    const disconnectedWrapper = mount(AgentPage, {
      global: { stubs: { Button: ButtonStub, TestCallDialog: TestCallDialogStub, AppTokensSection: true } },
    });

    expect((disconnectedWrapper.findAll('button').find((button) => button.text() === 'Agent simulation')!.element as HTMLButtonElement).disabled).toBe(true);
    disconnectedWrapper.unmount();

    getState.mockReturnValue(appState({ callId: 'active-call' }));
    const activeWrapper = mount(AgentPage, {
      global: { stubs: { Button: ButtonStub, TestCallDialog: TestCallDialogStub, AppTokensSection: true } },
    });
    expect((activeWrapper.findAll('button').find((button) => button.text() === 'Agent simulation')!.element as HTMLButtonElement).disabled).toBe(true);
    activeWrapper.unmount();
  });
});
