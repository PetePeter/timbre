import { describe, expect, it } from 'vitest';
import { ActivityFeed } from './activity-feed';
import type { RecordEvent } from './api';

function event(
  eventId: string,
  interactionId: string,
  kind: RecordEvent['kind'],
  type: RecordEvent['type'],
  occurredAt: string,
  details: Record<string, unknown> = {},
): RecordEvent {
  return { eventId, interactionId, kind, type, occurredAt, details };
}

describe('ActivityFeed', () => {
  it('projects per-phone call, SMS and agent activity and counts only real interaction starts', () => {
    const feed = new ActivityFeed();
    const phone = { id: 'phone-a', name: 'Kitchen' };
    feed.seed(phone.id, [
      event('call-start', 'call-1', 'call', 'call.started', '2026-10-31T01:00:00.000Z', { direction: 'inbound', contact: 'Alice' }),
      event('call-answer', 'call-1', 'call', 'call.answered', '2026-10-31T01:00:20.000Z'),
      event('sms-in', 'sms-1', 'sms', 'sms.received', '2026-10-31T02:00:00.000Z', { from: '+61000000000', text: '<img onerror=alert(1)>' }),
      event('tool-start', 'tool-1', 'system', 'agent.tool_started', '2026-10-31T03:00:00.000Z', { toolName: 'phone_inbox' }),
      event('tool-end', 'tool-1', 'system', 'agent.tool_finished', '2026-10-31T03:00:02.000Z', { toolName: 'phone_inbox', outcome: 'completed' }),
    ]);

    const lanes = feed.lanes([phone], Date.parse('2026-10-31T01:01:00.000Z'));
    expect(lanes).toHaveLength(1);
    expect(lanes[0].phoneName).toBe('Kitchen');
    expect(lanes[0].items.map(({ kind }) => kind)).toEqual(['agent', 'sms', 'call']);
    expect(lanes[0].items.at(-1)).toMatchObject({ kind: 'call', direction: 'inbound', state: 'active', durationSeconds: 40, detail: 'Alice' });
    expect(lanes[0].items[1].detail).not.toContain('<img');

    const today = feed.today([phone], Date.parse('2026-10-30T13:00:00.000Z'), Date.parse('2026-10-31T13:00:00.000Z'));
    expect(today).toMatchObject({ calls: 1, sms: 1, agentActions: 1, total: 3 });
    expect(today.hourly.reduce((sum, count) => sum + count, 0)).toBe(3);
  });

  it('updates a live call on appended end events without double-counting duplicate stream delivery', () => {
    const feed = new ActivityFeed();
    const phone = { id: 'phone-a', name: 'Kitchen' };
    feed.seed(phone.id, [event('start', 'call-1', 'call', 'call.started', '2026-10-31T01:00:00.000Z', { direction: 'outbound', to: '+61000000000' })]);
    const ended = event('end', 'call-1', 'call', 'call.ended', '2026-10-31T01:02:00.000Z', { durationSeconds: 95 });
    feed.append(phone.id, ended);
    feed.append(phone.id, ended);

    expect(feed.lanes([phone], Date.parse('2026-10-31T01:03:00.000Z'))[0].items[0]).toMatchObject({
      kind: 'call', direction: 'outbound', state: 'ended', durationSeconds: 95, detail: '+61000000000',
    });
    expect(feed.today([phone], Date.parse('2026-10-31T00:00:00.000Z'), Date.parse('2026-11-01T00:00:00.000Z')).calls).toBe(1);
  });
});
