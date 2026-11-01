// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import EventTimeline from './components/EventTimeline.vue';
import type { RecordEvent } from './api';

describe('EventTimeline', () => {
  it('shows the call agent report summary', () => {
    const event: RecordEvent = {
      eventId: 'event-1', interactionId: 'call-1', kind: 'call', type: 'call.agent_reported',
      occurredAt: '2026-10-30T00:00:00.000Z', details: { summary: 'Appointment booked.' },
    };
    const wrapper = mount(EventTimeline, { props: { events: [event] } });
    expect(wrapper.text()).toContain('Call agent report');
    expect(wrapper.text()).toContain('Appointment booked.');
    expect(wrapper.text()).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('shows owner takeover outcomes without exposing call text', () => {
    const event: RecordEvent = {
      eventId: 'event-2', interactionId: 'call-2', kind: 'call', type: 'call.owner_takeover',
      occurredAt: '2026-10-30T00:00:00.000Z', details: { outcome: 'succeeded' },
    };
    const wrapper = mount(EventTimeline, { props: { events: [event] } });
    expect(wrapper.text()).toContain('Owner takeover');
    expect(wrapper.text()).toContain('Owner joined the call.');
  });
});
