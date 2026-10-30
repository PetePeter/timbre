import { describe, expect, it } from 'vitest';
import { CallSummaryNotifier, shouldNotifyCallSummary, splitSummarySms } from '../src/notify/call-summary.js';

describe('call summary notification matching', () => {
  it('sends all at call end and does not send again when the outcome arrives', () => {
    const preferences = ['all', 'handed_over'] as const;

    expect(shouldNotifyCallSummary({ preferences, trigger: 'call_ended', answered: true })).toBe(true);
    expect(shouldNotifyCallSummary({ preferences, trigger: 'call_outcome', answered: true, outcome: 'handed_over' })).toBe(false);
  });

  it('matches missed to early hangups and calls that ended before answer', () => {
    const preferences = ['missed'] as const;

    expect(shouldNotifyCallSummary({ preferences, trigger: 'call_ended', answered: false })).toBe(true);
    expect(shouldNotifyCallSummary({ preferences, trigger: 'call_outcome', answered: true, outcome: 'early_hangup' })).toBe(true);
    expect(shouldNotifyCallSummary({ preferences, trigger: 'call_outcome', answered: true, outcome: 'confused' })).toBe(false);
  });

  it('matches only handed-over and left-message outcomes', () => {
    expect(shouldNotifyCallSummary({ preferences: ['handed_over'], trigger: 'call_outcome', answered: true, outcome: 'handed_over' })).toBe(true);
    expect(shouldNotifyCallSummary({ preferences: ['left_message'], trigger: 'call_outcome', answered: true, outcome: 'left_message' })).toBe(true);
    expect(shouldNotifyCallSummary({ preferences: ['handed_over', 'left_message'], trigger: 'call_outcome', answered: true, outcome: 'spam' })).toBe(false);
    expect(shouldNotifyCallSummary({ preferences: [], trigger: 'call_ended', answered: true })).toBe(false);
  });
});

describe('call summary SMS splitting', () => {
  it('keeps short summaries as one part', () => {
    expect(splitSummarySms('Call ended normally.')).toEqual(['Call ended normally.']);
  });

  it('caps a long summary at three SMS-sized parts', () => {
    const parts = splitSummarySms(`Call details: ${'caller update '.repeat(100)}`);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(parts.every((part) => part.length > 0 && part.length <= 153)).toBe(true);
    expect(parts[0]).toMatch(/^Call details:/);
  });

  it('caps UCS-2 text by provider segment units, not Unicode character count', () => {
    const parts = splitSummarySms('😀'.repeat(400));

    expect(parts).toHaveLength(3);
    expect(parts.every((part) => Array.from(part).reduce((units, char) => units + char.length, 0) <= 67)).toBe(true);
    expect(parts.join('').length).toBeLessThan(400 * 2);
  });

  it('counts GSM-7 extension characters as two septets', () => {
    const parts = splitSummarySms('^'.repeat(500));

    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.length + (part.match(/\^/g)?.length ?? 0) <= 153)).toBe(true);
  });

  it('reserves segment units for the signature appended by the SMS transport', () => {
    const signature = '\n— Timbre';
    const parts = splitSummarySms('a'.repeat(180), 3, signature);

    expect(parts).toHaveLength(3);
    expect(parts.every((part) => (part + signature).length <= 67)).toBe(true);
  });

  it('does not emit a segment when the suffix leaves no room for a Unicode character', () => {
    expect(splitSummarySms('😀😀😀', 3, 'x'.repeat(66))).toEqual([]);
  });

  it('returns no parts for blank text', () => {
    expect(splitSummarySms('  \n  ')).toEqual([]);
  });

  it('sends at most once per contact and records notification metadata without the summary body', async () => {
    const sent: string[] = [];
    const records: Array<{ type: string; details: Record<string, unknown> }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const notifier = new CallSummaryNotifier({
      sendSms: async (_contact, text) => {
        sent.push(text);
        await gate;
        return { sent: true };
      },
      recordEvent: (_interactionId, type, details) => records.push({ type, details }),
    });
    const notification = {
      interactionId: 'call-1', contactId: 'user-1',
      contact: { label: 'Casey', pattern: '+61412345678', role: 'owner' as const, callIn: true, callOut: true, smsIn: true, smsOut: true, conf: false, pin: '', messages: false },
      outcome: 'handed_over', summary: 'Caller asked for a return call.',
    };

    const first = notifier.notify(notification);
    const duplicate = notifier.notify(notification);
    release();
    await Promise.all([first, duplicate]);

    expect(sent).toHaveLength(1);
    expect(records).toEqual([{ type: 'notify.sent', details: {
      contactId: 'user-1', outcome: 'handed_over', partsSent: 1, partsTotal: 1,
    } }]);
    expect(JSON.stringify(records)).not.toContain('Caller asked for a return call.');
  });

  it('records a send failure once and does not retry it on duplicate call delivery', async () => {
    let calls = 0;
    const records: Array<{ type: string; details: Record<string, unknown> }> = [];
    const notifier = new CallSummaryNotifier({
      sendSms: async () => { calls++; return { sent: false, reason: 'sms.out denied' }; },
      recordEvent: (_interactionId, type, details) => records.push({ type, details }),
    });
    const notification = {
      interactionId: 'call-2', contactId: 'user-2',
      contact: { label: 'Casey', pattern: '+61412345678', role: 'trusted' as const, callIn: true, callOut: true, smsIn: true, smsOut: true, conf: false, pin: '', messages: false },
      outcome: 'left_message', summary: 'Caller left a message.',
    };

    await notifier.notify(notification);
    await notifier.notify(notification);

    expect(calls).toBe(1);
    expect(records).toEqual([{ type: 'notify.failed', details: {
      contactId: 'user-2', outcome: 'left_message', partsSent: 0, partsTotal: 1, reason: 'sms.out denied',
    } }]);
  });
});
