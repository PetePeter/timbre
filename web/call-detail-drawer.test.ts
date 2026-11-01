// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import CallDetailDrawer from './components/CallDetailDrawer.vue';
import type { RecordSummary } from './api';

describe('CallDetailDrawer', () => {
  it('shows call timestamps with seconds', async () => {
    const record: RecordSummary = {
      id: 'call-1', kind: 'call', direction: 'inbound', contact: 'Casey',
      occurredAt: '2026-10-30T00:00:07.000Z', lastEventAt: '2026-10-30T00:00:07.000Z',
      action: 'call.ended', hasConference: false, blocked: false, events: [],
    };
    const wrapper = mount(CallDetailDrawer, {
      props: { visible: true, phoneId: null, record },
      global: { plugins: [[PrimeVue, { unstyled: true }]], stubs: { CallArtifacts: true } },
      attachTo: document.body,
    });
    await flushPromises();

    try {
      expect(document.body.textContent ?? '').toMatch(/\d{2}:\d{2}:07/);
    } finally {
      wrapper.unmount();
    }
  });
});
