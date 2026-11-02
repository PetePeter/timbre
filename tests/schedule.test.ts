import { describe, expect, it } from 'vitest';
import { resolveActiveScheduleSlot } from '../src/phone/schedule.js';
import { NO_SMS_AUTO_REPLY } from '../src/phone/sms-auto-reply-policy.js';

const policy = (action: 'standard' | 'always-through' | 'message' | 'block', greeting = '') => ({
  action, greeting, instructions: '', smsAutoReply: NO_SMS_AUTO_REPLY,
});

describe('resolveActiveScheduleSlot', () => {
  it('matches the configured weekday and treats the end time as exclusive', () => {
    const schedule = { timeZone: 'Australia/Sydney', slots: [
      { id: 'weekday', days: [1], start: '09:00', end: '17:00', ...policy('message', 'Work hours') },
    ] };

    expect(resolveActiveScheduleSlot(schedule, new Date('2026-10-26T00:00:00Z'))?.greeting).toBe('Work hours');
    expect(resolveActiveScheduleSlot(schedule, new Date('2026-10-26T06:00:00Z'))).toBeNull();
  });

  it('keeps an overnight slot active after midnight on the following weekday', () => {
    const schedule = { timeZone: 'Australia/Sydney', slots: [
      { id: 'overnight', days: [5], start: '22:00', end: '02:00', ...policy('message', 'Night shift') },
    ] };

    expect(resolveActiveScheduleSlot(schedule, new Date('2026-10-30T14:00:00Z'))?.greeting).toBe('Night shift');
    expect(resolveActiveScheduleSlot(schedule, new Date('2026-10-30T16:00:00Z'))).toBeNull();
  });

  it('chooses the latest local start when slots overlap and keeps the first slot on a tie', () => {
    const schedule = { timeZone: 'Australia/Sydney', slots: [
      { id: 'earlier', days: [1], start: '08:00', end: '18:00', ...policy('message', 'Earlier') },
      { id: 'later', days: [1], start: '10:00', end: '16:00', ...policy('block', 'Later') },
      { id: 'tie', days: [1], start: '10:00', end: '15:00', ...policy('standard', 'Tie') },
    ] };

    expect(resolveActiveScheduleSlot(schedule, new Date('2026-10-26T01:00:00Z'))?.greeting).toBe('Later');
  });

  it('uses local wall time across the Sydney spring DST jump', () => {
    const schedule = { timeZone: 'Australia/Sydney', slots: [
      { id: 'dst', days: [0], start: '01:30', end: '03:30', ...policy('message', 'Sunday') },
    ] };

    expect(resolveActiveScheduleSlot(schedule, new Date('2026-10-03T15:45:00Z'))?.greeting).toBe('Sunday');
    expect(resolveActiveScheduleSlot(schedule, new Date('2026-10-03T16:00:00Z'))?.greeting).toBe('Sunday');
  });

});
