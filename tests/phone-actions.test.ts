import { describe, expect, it, vi } from 'vitest';
import { sendSmsAction } from '../src/actions/phone-actions.js';
import type { Hub } from '../src/hub.js';
import type { PhoneEntry } from '../src/config/timbre-config.js';
import { resolvePhoneLineConfig } from '../src/phone/phone-config.js';

const phone = { id: 'phone-1', line: resolvePhoneLineConfig({}) } as PhoneEntry;

describe('sendSmsAction', () => {
  it('pins an internal auto-reply to the original sender and dispatches through the action-only line method', async () => {
    const line = {
      sendSms: vi.fn(async () => ({ sent: true })),
      sendSmsFromAction: vi.fn(async () => ({ sent: true })),
    };
    const hub = { line: vi.fn(() => line) } as unknown as Hub;
    const authorization = { sourceNumber: '+61400000001', allowUnknown: true };

    await expect(sendSmsAction(
      { hub }, phone, '+61400000002', 'Thanks.', 'Timbre', authorization, 'sms:123',
    )).resolves.toEqual({ sent: true });

    expect(line.sendSmsFromAction).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: authorization.sourceNumber }), 'Thanks.', 'sms:123', 'Timbre', authorization,
    );
    expect(line.sendSms).not.toHaveBeenCalled();
  });

  it('keeps ordinary sends on the normal policy-checked line method', async () => {
    const line = {
      sendSms: vi.fn(async () => ({ sent: true })),
      sendSmsFromAction: vi.fn(async () => ({ sent: true })),
    };
    const hub = { line: vi.fn(() => line) } as unknown as Hub;

    await expect(sendSmsAction({ hub }, phone, '+61400000001', 'Hello.', 'Calendar'))
      .resolves.toEqual({ sent: true });

    expect(line.sendSms).toHaveBeenCalledWith(expect.objectContaining({ pattern: '+61400000001' }), 'Hello.', undefined, 'Calendar');
    expect(line.sendSmsFromAction).not.toHaveBeenCalled();
  });

  it('resolves a contact name to its configured SMS destination without replacing it with the name', async () => {
    const line = { sendSms: vi.fn(async () => ({ sent: true })) };
    const hub = { line: vi.fn(() => line) } as unknown as Hub;
    const phoneWithMum = {
      ...phone,
      line: resolvePhoneLineConfig({ contacts: [{
        contactId: 'mum-id', label: 'Mum', pattern: '+61400000001', role: 'trusted',
        callIn: true, callOut: true, smsIn: true, smsOut: true, conf: false, pin: '', messages: false,
      }] }),
    } as PhoneEntry;

    await expect(sendSmsAction({ hub }, phoneWithMum, 'Mum', 'Hello.')).resolves.toEqual({ sent: true });
    expect(line.sendSms).toHaveBeenCalledWith(expect.objectContaining({ label: 'Mum', pattern: '+61400000001' }), 'Hello.', undefined, undefined);
  });
});
