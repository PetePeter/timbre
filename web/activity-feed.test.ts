import { describe, expect, it } from 'vitest';
import { ActivityFeed } from './activity-feed';
import type { RecordEvent } from './api';

function event(eventId: string, interactionId: string, type: RecordEvent['type'], occurredAt: string): RecordEvent {
  return { eventId, interactionId, kind: type.startsWith('call.') ? 'call' : type.startsWith('sms.') ? 'sms' : 'system', type, occurredAt, details: {} };
}

describe('ActivityFeed daily counts', () => {
  it('counts calls and texts once across phones while excluding agent tool steps', () => {
    const feed = new ActivityFeed();
    feed.seed('home', [
      event('start', 'call-1', 'call.started', '2026-11-01T01:00:00.000Z'),
      event('answer', 'call-1', 'call.answered', '2026-11-01T01:00:10.000Z'),
      event('tool-start', 'call-1', 'agent.tool_started', '2026-11-01T01:00:20.000Z'),
      event('tool-finished', 'call-1', 'agent.tool_finished', '2026-11-01T01:00:21.000Z'),
      event('text-in', 'sms-1', 'sms.received', '2026-11-01T02:00:00.000Z'),
    ]);
    feed.append('home', event('start', 'call-1', 'call.started', '2026-11-01T01:00:00.000Z'));
    feed.append('work', event('text-out', 'sms-2', 'sms.sent', '2026-11-01T03:00:00.000Z'));
    const today = feed.today([{ id: 'home', name: 'Home' }, { id: 'work', name: 'Work' }], Date.parse('2026-11-01T00:00:00Z'), Date.parse('2026-11-02T00:00:00Z'));
    expect(today).toMatchObject({ calls: 1, sms: 2, total: 3 });
    expect(today.hourly.reduce((sum, count) => sum + count, 0)).toBe(3);
  });
});
