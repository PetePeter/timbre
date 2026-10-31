// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import TodayStrip from './components/TodayStrip.vue';

let wrappers: VueWrapper[] = [];
afterEach(() => { wrappers.splice(0).forEach((wrapper) => wrapper.unmount()); });

describe('Switchboard daily totals', () => {
  it('shows only call and text totals from real events', () => {
    const counts = { calls: 2, sms: 3, total: 5, hourly: Array.from({ length: 24 }, (_, hour) => hour === 8 ? 3 : 0) };
    const wrapper = mount(TodayStrip, { props: { counts, loading: false } });
    wrappers.push(wrapper);
    expect(wrapper.text()).toContain('2Calls');
    expect(wrapper.text()).toContain('3Texts');
    expect(wrapper.text()).not.toContain('Agent actions');
    expect(wrapper.get('.today-strip').attributes('aria-label')).toBe('Today: 2 calls, 3 text messages');
    expect(wrapper.findAll('.today-strip i')).toHaveLength(24);
  });
});
