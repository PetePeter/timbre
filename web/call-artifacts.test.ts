// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import CallArtifacts from './components/CallArtifacts.vue';
import { api, type CallArtifacts as CallArtifactsData, type RecordSummary } from './api';

class FakeAudioNode {
  readonly connections: Array<{ destination: FakeAudioNode; input: number }> = [];

  connect(destination: FakeAudioNode, _output = 0, input = 0): FakeAudioNode {
    this.connections.push({ destination, input });
    return destination;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = { value: 1 };
  channelCount = 2;
  channelCountMode: ChannelCountMode = 'max';
  channelInterpretation: ChannelInterpretation = 'speakers';
}

class FakeAudioContext {
  readonly destination = new FakeAudioNode();
  readonly source = new FakeAudioNode();
  readonly gain = new FakeGainNode();
  readonly merger = new FakeAudioNode();
  readonly mediaElements: HTMLMediaElement[] = [];
  mergerInputs = 0;
  resumeCalls = 0;
  closeCalls = 0;
  state: AudioContextState = 'suspended';
  failMerger = false;

  createMediaElementSource(element: HTMLMediaElement): MediaElementAudioSourceNode {
    this.mediaElements.push(element);
    return this.source as unknown as MediaElementAudioSourceNode;
  }

  createGain(): GainNode {
    return this.gain as unknown as GainNode;
  }

  createChannelMerger(inputs: number): ChannelMergerNode {
    this.mergerInputs = inputs;
    if (this.failMerger) throw new Error('Channel merger unavailable');
    return this.merger as unknown as ChannelMergerNode;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const record = { id: 'call-1', kind: 'call', events: [] } as unknown as RecordSummary;

describe('CallArtifacts', () => {
  it('renders a summary as text when no transcript is available', async () => {
    const hostileSummary = 'Caller said <img src=x onerror="alert(1)"> & asked for help.';
    vi.spyOn(api, 'callArtifacts').mockResolvedValue({
      transcript: null, summary: hostileSummary, audioAvailable: false,
    } satisfies CallArtifactsData);

    const wrapper = mount(CallArtifacts, { props: { visible: false, phoneId: 'phone-1', record } });
    await wrapper.setProps({ visible: true });
    await flushPromises();

    expect(wrapper.text()).toContain(hostileSummary);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('No transcript is available for this call.');
    wrapper.unmount();
  });

  it('shows the summary alongside transcript lines', async () => {
    vi.spyOn(api, 'callArtifacts').mockResolvedValue({
      transcript: {
        date: '2026-10-30T00:00:00.000Z', contact: 'Casey', role: 'trusted', direction: 'inbound',
        durationS: 10, handledBy: [], utterances: [{ speaker: 'remote', text: 'Please call tomorrow.', startMs: 0 }],
      },
      summary: 'Caller requested a callback tomorrow.', audioAvailable: false,
    } satisfies CallArtifactsData);

    const wrapper = mount(CallArtifacts, { props: { visible: false, phoneId: 'phone-1', record } });
    await wrapper.setProps({ visible: true });
    await flushPromises();

    expect(wrapper.text()).toContain('Caller requested a callback tomorrow.');
    expect(wrapper.text()).toContain('Please call tomorrow.');
    wrapper.unmount();
  });

  it('centres saved call audio while retaining the native audio controls', async () => {
    const contexts: FakeAudioContext[] = [];
    vi.stubGlobal('AudioContext', class extends FakeAudioContext {
      constructor() {
        super();
        contexts.push(this);
      }
    });
    vi.spyOn(api, 'callArtifacts').mockResolvedValue({
      transcript: null, summary: null, audioAvailable: true,
    } satisfies CallArtifactsData);
    vi.spyOn(api, 'callAudioUrl').mockReturnValue('/recording.wav');

    const wrapper = mount(CallArtifacts, { props: { visible: false, phoneId: 'phone-1', record } });
    await wrapper.setProps({ visible: true });
    await flushPromises();

    const context = contexts[0];
    const audio = wrapper.get('audio').element as HTMLAudioElement;
    expect(audio.controls).toBe(true);
    expect(audio.src).toBe(`${window.location.origin}/recording.wav`);
    expect(context.mediaElements).toEqual([audio]);
    expect(context.gain.channelCount).toBe(1);
    expect(context.gain.channelCountMode).toBe('explicit');
    expect(context.gain.channelInterpretation).toBe('speakers');
    expect(context.source.connections).toEqual([{ destination: context.gain, input: 0 }]);
    expect(context.gain.connections).toEqual([
      { destination: context.merger, input: 0 },
      { destination: context.merger, input: 1 },
    ]);
    expect(context.merger.connections).toEqual([{ destination: context.destination, input: 0 }]);

    audio.dispatchEvent(new Event('play'));
    await flushPromises();
    expect(context.resumeCalls).toBe(1);

    wrapper.unmount();
    await flushPromises();
    expect(context.closeCalls).toBe(1);
  });

  it('keeps native stereo playback when Web Audio is unavailable', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.spyOn(api, 'callArtifacts').mockResolvedValue({
      transcript: null, summary: null, audioAvailable: true,
    } satisfies CallArtifactsData);

    const wrapper = mount(CallArtifacts, { props: { visible: false, phoneId: 'phone-1', record } });
    await wrapper.setProps({ visible: true });
    await flushPromises();

    const audio = wrapper.get('audio').element as HTMLAudioElement;
    expect(audio.controls).toBe(true);
    expect(audio.src).toContain('recordings');
    wrapper.unmount();
  });

  it('reconnects the source in stereo if mono routing cannot be created', async () => {
    const contexts: FakeAudioContext[] = [];
    vi.stubGlobal('AudioContext', class extends FakeAudioContext {
      constructor() {
        super();
        this.failMerger = true;
        contexts.push(this);
      }
    });
    vi.spyOn(api, 'callArtifacts').mockResolvedValue({
      transcript: null, summary: null, audioAvailable: true,
    } satisfies CallArtifactsData);

    const wrapper = mount(CallArtifacts, { props: { visible: false, phoneId: 'phone-1', record } });
    await wrapper.setProps({ visible: true });
    await flushPromises();

    const context = contexts[0];
    expect(context.source.connections).toEqual([{ destination: context.destination, input: 0 }]);
    expect((wrapper.get('audio').element as HTMLAudioElement).controls).toBe(true);
    wrapper.unmount();
  });
});
