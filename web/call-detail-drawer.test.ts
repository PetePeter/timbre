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

  it('shows received and sent SMS bodies together above the event history', async () => {
    const record: RecordSummary = {
      id: 'sms-1', kind: 'sms', direction: 'inbound', contact: 'Casey',
      occurredAt: '2026-10-30T00:00:07.000Z', lastEventAt: '2026-10-30T00:01:07.000Z',
      action: 'sms.sent', hasConference: false, blocked: false, events: [
        { eventId: 'in', interactionId: 'sms-1', kind: 'sms', type: 'sms.received', occurredAt: '2026-10-30T00:00:07.000Z', details: { text: 'Can you call me?' } },
        { eventId: 'out', interactionId: 'sms-1', kind: 'sms', type: 'sms.sent', occurredAt: '2026-10-30T00:01:07.000Z', details: { text: 'Yes, after lunch.' } },
      ],
    };
    const wrapper = mount(CallDetailDrawer, {
      props: { visible: true, phoneId: null, record },
      global: { plugins: [[PrimeVue, { unstyled: true }]], stubs: { CallArtifacts: true } },
      attachTo: document.body,
    });
    await flushPromises();

    try {
      const messages = document.body.querySelector('[aria-label="Text messages"]');
      expect(messages).not.toBeNull();
      expect(Array.from(messages!.querySelectorAll('li')).map((item) => item.textContent)).toEqual([
        expect.stringContaining('Received'),
        expect.stringContaining('Sent'),
      ]);
      expect(messages?.textContent).toContain('Can you call me?');
      expect(messages?.textContent).toContain('Yes, after lunch.');
      expect(document.body.textContent?.match(/Can you call me\?/g)).toHaveLength(1);
      expect(document.body.textContent!.indexOf('Messages')).toBeLessThan(document.body.textContent!.indexOf('What Timbre did'));
    } finally {
      wrapper.unmount();
    }
  });
});
