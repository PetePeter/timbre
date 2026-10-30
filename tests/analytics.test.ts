import { describe, expect, it } from 'vitest';
import type { RecordEvent, RecordEventType } from '../src/records/event-types.js';
import { aggregateCallAnalytics } from '../src/records/analytics.js';

function event(
  eventId: string,
  interactionId: string,
  type: RecordEventType,
  occurredAt: string,
  details: Record<string, unknown> = {},
): RecordEvent {
  return { eventId, interactionId, kind: 'call', type, occurredAt, details };
}

describe('call analytics', () => {
  it('uses call start for range membership and complete histories for outcome and handover results', () => {
    const events = [
      event('a-start', 'a', 'call.started', '2026-10-29T10:00:00.000Z'),
      event('a-transfer', 'a', 'call.transferred', '2026-10-29T10:00:30.000Z'),
      event('a-conference', 'a', 'conference.added', '2026-10-29T10:00:45.000Z'),
      event('a-end', 'a', 'call.ended', '2026-10-29T10:01:00.000Z', { durationSeconds: 60 }),
      event('a-outcome', 'a', 'call.outcome', '2026-10-29T10:01:01.000Z', { outcome: 'spam', source: 'agent' }),
      event('b-start', 'b', 'call.started', '2026-10-29T10:05:00.000Z'),
      event('b-end', 'b', 'call.ended', '2026-10-29T10:05:09.000Z', { durationSeconds: 9 }),
      event('c-start', 'c', 'call.started', '2026-10-29T10:06:00.000Z'),
      event('c-conference', 'c', 'conference.added', '2026-10-29T10:06:20.000Z'),
      event('c-transfer', 'c', 'call.transferred', '2026-10-29T10:06:30.000Z'),
      event('c-end', 'c', 'call.ended', '2026-10-29T10:08:00.000Z', { durationSeconds: 120 }),
      event('d-start', 'd', 'call.started', '2026-10-29T10:07:00.000Z'),
      event('d-end', 'd', 'call.ended', '2026-10-29T10:07:30.000Z', { durationSeconds: 30 }),
      event('e-start', 'e', 'call.started', '2026-10-29T10:07:30.000Z'),
      event('e-end', 'e', 'call.ended', '2026-10-29T10:07:40.000Z', { durationSeconds: 10 }),
      event('outside-start', 'outside', 'call.started', '2026-10-29T10:08:00.000Z'),
      event('outside-outcome', 'outside', 'call.outcome', '2026-10-29T10:08:01.000Z', { outcome: 'spam', source: 'agent' }),
    ];

    const result = aggregateCallAnalytics(events, {
      from: '2026-10-29T10:00:00.000Z',
      to: '2026-10-29T10:08:00.000Z',
    });

    expect(result.totalCalls).toBe(5);
    expect(result.averageDurationSeconds).toBe(45.8);
    expect(result.outcomes).toEqual([
      { outcome: 'left_message', count: 0, share: 0, averageDurationSeconds: null },
      { outcome: 'confused', count: 0, share: 0, averageDurationSeconds: null },
      { outcome: 'thought_human', count: 0, share: 0, averageDurationSeconds: null },
      { outcome: 'spam', count: 1, share: 0.2, averageDurationSeconds: 60 },
      { outcome: 'handed_over', count: 1, share: 0.2, averageDurationSeconds: 120 },
      { outcome: 'early_hangup', count: 1, share: 0.2, averageDurationSeconds: 9 },
      { outcome: 'unreported', count: 2, share: 0.4, averageDurationSeconds: 20 },
    ]);
    expect(result.handovers).toEqual({ attempts: 2, successes: 1, rate: 0.5 });
  });

  it('returns a null handover rate when there are no attempts', () => {
    const result = aggregateCallAnalytics([
      event('start', 'call', 'call.started', '2026-10-29T10:00:00.000Z'),
    ], { from: '2026-10-29T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z' });

    expect(result.handovers).toEqual({ attempts: 0, successes: 0, rate: null });
    expect(result.outcomes.find(({ outcome }) => outcome === 'unreported')?.count).toBe(1);
  });

  it('excludes test interactions even when their events are mixed with production calls', () => {
    const regular = [
      event('prod-start', 'prod', 'call.started', '2026-10-29T10:00:00.000Z'),
      event('prod-end', 'prod', 'call.ended', '2026-10-29T10:01:00.000Z', { durationSeconds: 60 }),
    ];
    const test: RecordEvent[] = [
      { ...event('test-start', 'test', 'call.started', '2026-10-29T10:02:00.000Z'), test: true },
      { ...event('test-end', 'test', 'call.ended', '2026-10-29T10:03:00.000Z', { durationSeconds: 60 }), test: true },
      { ...event('test-outcome', 'test', 'call.outcome', '2026-10-29T10:03:01.000Z', { outcome: 'spam' }), test: true },
    ];

    const result = aggregateCallAnalytics([...regular, ...test]);

    expect(result.totalCalls).toBe(1);
    expect(result.averageDurationSeconds).toBe(60);
    expect(result.outcomes.find(({ outcome }) => outcome === 'spam')?.count).toBe(0);
  });

  it('keeps a 9.6-second heuristic early hangup after the display duration rounds to ten seconds', () => {
    const result = aggregateCallAnalytics([
      event('start', 'short', 'call.started', '2026-10-29T10:00:00.000Z'),
      event('end', 'short', 'call.ended', '2026-10-29T10:00:09.600Z', { durationSeconds: 10, durationMilliseconds: 9_600 }),
      event('outcome', 'short', 'call.outcome', '2026-10-29T10:00:11.000Z', { outcome: 'early_hangup', source: 'heuristic' }),
    ], { from: '2026-10-29T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z' });

    expect(result.averageDurationSeconds).toBe(9.6);
    expect(result.outcomes.find(({ outcome }) => outcome === 'early_hangup'))
      .toMatchObject({ count: 1, averageDurationSeconds: 9.6 });
    expect(result.outcomes.find(({ outcome }) => outcome === 'unreported')?.count).toBe(0);
  });
});
