// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import CallArtifacts from './components/CallArtifacts.vue';
import { api, type CallArtifacts as CallArtifactsData, type RecordSummary } from './api';

afterEach(() => vi.restoreAllMocks());

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
});
