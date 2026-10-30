import { describe, expect, it } from 'vitest';
import { SmsAutoReplyCooldown, getReplyableSmsNumber } from '../src/phone/sms-auto-reply.js';

describe('getReplyableSmsNumber', () => {
  it('requires an explicit own number and returns normalized telephone senders', () => {
    expect(getReplyableSmsNumber('0491 570 187', '0491 570 156', '+61')).toBe('+61491570187');
    expect(getReplyableSmsNumber('0491 570 187', '', '+61')).toBeNull();
    expect(getReplyableSmsNumber('not a number', '0491 570 156', '+61')).toBeNull();
  });

  it('rejects the own number, alphanumeric sender IDs, and short numeric IDs', () => {
    expect(getReplyableSmsNumber('+61491570156', '0491 570 156', '+61')).toBeNull();
    expect(getReplyableSmsNumber('MyBank', '+61491570156', '+61')).toBeNull();
    expect(getReplyableSmsNumber('123456', '+61491570156', '+61')).toBeNull();
  });
});

describe('SmsAutoReplyCooldown', () => {
  it('reserves each sender independently and expires at the cooldown boundary', () => {
    const cooldown = new SmsAutoReplyCooldown(100, 10);
    expect(cooldown.tryReserve('+61400000001', 0)).toBe(true);
    expect(cooldown.tryReserve('+61400000001', 99)).toBe(false);
    expect(cooldown.tryReserve('+61400000002', 99)).toBe(true);
    expect(cooldown.tryReserve('+61400000001', 100)).toBe(true);
  });

  it('fails closed at capacity without evicting active sender cooldowns', () => {
    const cooldown = new SmsAutoReplyCooldown(100, 2);
    expect(cooldown.tryReserve('+61400000001', 0)).toBe(true);
    expect(cooldown.tryReserve('+61400000002', 0)).toBe(true);
    expect(cooldown.tryReserve('+61400000003', 1)).toBe(false);
    expect(cooldown.tryReserve('+61400000001', 1)).toBe(false);
    expect(cooldown.size).toBe(2);

    cooldown.prune(100);
    expect(cooldown.size).toBe(0);
    expect(cooldown.tryReserve('+61400000003', 100)).toBe(true);
  });
});
