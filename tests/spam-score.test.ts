import { describe, expect, it } from 'vitest';
import { calculateSpamScore } from '../src/phone/spam-score.js';

type HistoryEvent = {
  type: string;
  interactionId: string;
  occurredAt: string;
  details: Record<string, unknown>;
};

const caller = '+61400000000';
const at = (hoursAgo: number) => new Date(Date.parse('2026-10-30T00:00:00.000Z') - hoursAgo * 3_600_000).toISOString();
const started = (id: string, hoursAgo: number, from = caller): HistoryEvent => ({
  type: 'call.started', interactionId: id, occurredAt: at(hoursAgo),
  details: { direction: 'inbound', from },
});
const outcome = (id: string, value: string, hoursAgo: number): HistoryEvent => ({
  type: 'call.outcome', interactionId: id, occurredAt: at(hoursAgo),
  details: { outcome: value, source: value === 'early_hangup' ? 'heuristic' : 'agent' },
});

describe('calculateSpamScore', () => {
  it('adds repeat short-call points for three early hangups in the last day', () => {
    const history = [
      started('a', 20), outcome('a', 'early_hangup', 19.99),
      started('b', 12), outcome('b', 'early_hangup', 11.99),
      started('c', 2), outcome('c', 'early_hangup', 1.99),
    ];

    expect(calculateSpamScore(caller, history, new Date('2026-10-30T00:00:00.000Z')))
      .toMatchObject({ score: 30, recentShortCalls: 3, spamVerdicts: 0, autoBlock: false });
  });

  it('adds a prior inbound block and caps spam verdict points at sixty', () => {
    const history: HistoryEvent[] = [
      { type: 'call.blocked', interactionId: 'blocked', occurredAt: at(30), details: { direction: 'inbound', from: caller } },
      started('spam-1', 4), outcome('spam-1', 'spam', 3.9),
      started('spam-2', 2), outcome('spam-2', 'spam', 1.9),
      started('spam-3', 1), outcome('spam-3', 'spam', 0.9),
    ];

    expect(calculateSpamScore(caller, history, new Date('2026-10-30T00:00:00.000Z')))
      .toMatchObject({ score: 80, spamVerdicts: 3, autoBlock: true });
  });

  it('ignores calls for another number, stale calls, and unsupported outcome values', () => {
    const history = [
      started('other', 1, '+61411111111'), outcome('other', 'spam', 0.9),
      started('old', 100), outcome('old', 'early_hangup', 99.9),
      started('unsupported', 1), outcome('unsupported', 'thought_human', 0.9),
    ];

    expect(calculateSpamScore(caller, history, new Date('2026-10-30T00:00:00.000Z')))
      .toMatchObject({ score: 0, recentShortCalls: 0, spamVerdicts: 0, autoBlock: false });
  });

  it('does not let malformed history produce a score', () => {
    expect(calculateSpamScore(caller, [null, {}, { type: 'call.outcome', occurredAt: 'invalid' }], new Date()))
      .toMatchObject({ score: 0, recentShortCalls: 0, spamVerdicts: 0, autoBlock: false });
  });
});
