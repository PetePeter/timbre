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

  it('shows the question a call agent asked its requester', () => {
    const event: RecordEvent = {
      eventId: 'event-question', interactionId: 'call-question', kind: 'call', type: 'call.agent_question',
      occurredAt: '2026-10-30T00:00:00.000Z', details: { question: 'Which dates in December?' },
    };
    const wrapper = mount(EventTimeline, { props: { events: [event] } });
    expect(wrapper.text()).toContain('Agent asked requester');
    expect(wrapper.text()).toContain('Which dates in December?');
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
