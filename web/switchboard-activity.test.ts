// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import ActivityLanes from './components/ActivityLanes.vue';
import TodayStrip from './components/TodayStrip.vue';
import type { ActivityLane } from './activity-feed';

let wrappers: VueWrapper[] = [];
afterEach(() => { wrappers.splice(0).forEach((wrapper) => wrapper.unmount()); });

describe('Switchboard activity components', () => {
  it('renders actual phone events as plain text with state and duration', () => {
    const lane: ActivityLane = {
      phoneId: 'phone-1', phoneName: 'Bedroom', items: [{
        id: 'call-1', phoneId: 'phone-1', phoneName: 'Bedroom', kind: 'call', title: 'Incoming call',
        detail: '<img src=x onerror=alert(1)>', state: 'active', direction: 'inbound',
        occurredAt: '2026-10-31T01:00:00.000Z', durationSeconds: 70,
      }],
    };
    const wrapper = mount(ActivityLanes, {
      props: { lanes: [lane], loading: false, error: '' },
      global: { plugins: [[PrimeVue, { unstyled: true }]] },
    });
    wrappers.push(wrapper);

    expect(wrapper.text()).toContain('Bedroom');
    expect(wrapper.text()).toContain('Incoming call');
    expect(wrapper.text()).toContain('In progress');
    expect(wrapper.text()).toContain('1m 10s');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows Today counts and real hourly activity instead of sample bars', () => {
    const counts = { calls: 2, sms: 3, agentActions: 4, total: 9, hourly: Array.from({ length: 24 }, (_, hour) => hour === 8 ? 3 : 0) };
    const wrapper = mount(TodayStrip, { props: { counts, loading: false } });
    wrappers.push(wrapper);

    expect(wrapper.text()).toContain('2Calls');
    expect(wrapper.text()).toContain('3Texts');
    expect(wrapper.text()).toContain('4Agent actions');
    expect(wrapper.get('.today-strip').attributes('aria-label')).toBe('Today: 2 calls, 3 text messages, 4 agent actions');
    expect(wrapper.findAll('.today-strip i')).toHaveLength(24);
    expect(wrapper.findAll('.today-strip i[title="8:00 · 3"]')).toHaveLength(1);
  });
});
