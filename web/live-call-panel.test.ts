// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reactive, nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { api } from './api';
import LiveCallPanel from './components/LiveCallPanel.vue';

const { getState } = vi.hoisted(() => ({ getState: vi.fn() }));
vi.mock('./app-state', () => ({ useAppState: () => getState() }));

class FakeEventSource {
  static all: FakeEventSource[] = [];
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onerror: ((event: Event) => unknown) | null = null;
  closed = false;

  constructor(readonly url: string) { FakeEventSource.all.push(this); }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const wrapped = (event: MessageEvent<string>) => {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    };
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }
  close(): void { this.closed = true; }
  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeAudioContext {
  static latest: FakeAudioContext | null = null;
  state = 'running';
  currentTime = 0;
  destination = {};
  closed = false;
  scheduled: Array<{ startedAt: number | null }> = [];
  constructor() { FakeAudioContext.latest = this; }
  async resume(): Promise<void> {}
  async close(): Promise<void> { this.closed = true; this.state = 'closed'; }
  createBuffer(_channels: number, samples: number, sampleRate: number) {
    return { duration: samples / sampleRate, getChannelData: () => new Float32Array(samples) };
  }
  createBufferSource() {
    const source = { buffer: null as unknown, startedAt: null as number | null, connect: () => undefined, start(when = 0) { source.startedAt = when; } };
    this.scheduled.push(source);
    return source;
  }
}

const ButtonStub = {
  props: { label: String, disabled: Boolean, loading: Boolean },
  emits: ['click'],
  template: '<button :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
};

function appState() {
  return reactive({
    selectedPhone: { id: 'phone-1', name: 'Desk' },
    selectedStatus: {
      line: { line: { connected: true, liveAudioAvailable: true, call: { callId: 'call-1', label: 'Caller', state: 'active' } } },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.all = [];
  FakeAudioContext.latest = null;
  getState.mockReset();
});

describe('LiveCallPanel', () => {
  it('opens text updates on the live call and starts audio only after Listen is clicked', async () => {
    const state = appState();
    getState.mockReturnValue(state);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const takeover = vi.spyOn(api, 'takeoverLiveCall').mockResolvedValue({ ok: true });
    const hangup = vi.spyOn(api, 'hangupLiveCall').mockResolvedValue({ hungUp: true });

    const wrapper = mount(LiveCallPanel, { global: { stubs: { Button: ButtonStub, TestCallDialog: true } } });
    expect(FakeEventSource.all).toHaveLength(1);
    expect(FakeEventSource.all[0].url).toContain('/live-call/events?callId=call-1');
    expect(FakeEventSource.all[0].url).not.toContain('/live-call/audio');

    FakeEventSource.all[0].emit('snapshot', {
      callId: 'call-1', label: 'Caller', state: 'active',
      utterances: [{ speaker: 'remote', text: 'Hello (Ctrl+C)', startMs: 1 }],
    });
    FakeEventSource.all[0].emit('utterance', {
      type: 'utterance', callId: 'call-1', utterance: { speaker: 'local', text: 'One moment.', startMs: 2 },
    });
    await nextTick();
    expect(wrapper.text()).toContain('Hello (Ctrl+C)');
    expect(wrapper.text()).toContain('Timbre: One moment.');

    await wrapper.findAll('button').find((button) => button.text() === 'Listen')!.trigger('click');
    await flushPromises();
    expect(FakeEventSource.all).toHaveLength(2);
    expect(FakeEventSource.all[1].url).toContain('/live-call/audio?callId=call-1');
    expect(FakeAudioContext.latest).not.toBeNull();
    FakeEventSource.all[1].emit('frame', {
      callId: 'call-1', sequence: 1, sampleRate: 8000, channels: 2, encoding: 'pcm_s16le', data: btoa('\0'.repeat(640)),
    });
    expect(FakeAudioContext.latest!.scheduled[0].startedAt).toBe(0.04);

    await wrapper.findAll('button').find((button) => button.text() === 'Take over')!.trigger('click');
    await flushPromises();
    expect(takeover).toHaveBeenCalledWith('phone-1', 'call-1');

    await wrapper.findAll('button').find((button) => button.text() === 'Hang up')!.trigger('click');
    await flushPromises();
    expect(hangup).toHaveBeenCalledWith('phone-1', 'call-1');

    state.selectedStatus.line.line.call.callId = 'call-2';
    await nextTick();
    await flushPromises();
    expect(FakeEventSource.all[0].closed).toBe(true);
    expect(FakeEventSource.all[1].closed).toBe(true);
    expect(FakeAudioContext.latest?.closed).toBe(true);
    expect(FakeEventSource.all[2].url).toContain('/live-call/events?callId=call-2');

    wrapper.unmount();
    expect(FakeEventSource.all[2].closed).toBe(true);
  });

  it('disables Listen when the phone does not advertise the PhAP live-audio capability', () => {
    const state = appState();
    state.selectedStatus.line.line.liveAudioAvailable = false;
    getState.mockReturnValue(state);
    vi.stubGlobal('EventSource', FakeEventSource);
    const wrapper = mount(LiveCallPanel, { global: { stubs: { Button: ButtonStub, TestCallDialog: true } } });
    const listen = wrapper.findAll('button').find((button) => button.text() === 'Listen')!;
    expect((listen.element as HTMLButtonElement).disabled).toBe(true);
    expect(FakeEventSource.all).toHaveLength(1);
    expect(FakeEventSource.all[0].url).toContain('/live-call/events');
    wrapper.unmount();
  });

  it('does not open the audio stream when Listen resumes after unmount', async () => {
    const state = appState();
    getState.mockReturnValue(state);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    let resume!: () => void;
    const resumeGate = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(FakeAudioContext.prototype, 'resume').mockImplementation(() => resumeGate);

    const wrapper = mount(LiveCallPanel, { global: { stubs: { Button: ButtonStub, TestCallDialog: true } } });
    await wrapper.findAll('button').find((button) => button.text() === 'Listen')!.trigger('click');
    const context = FakeAudioContext.latest!;
    wrapper.unmount();
    resume();
    await flushPromises();

    expect(context.closed).toBe(true);
    expect(FakeEventSource.all).toHaveLength(1);
    expect(FakeEventSource.all[0].url).toContain('/live-call/events');
  });
});
