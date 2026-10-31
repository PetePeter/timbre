import type { RecordEvent } from './api';

export interface ActivityPhone { id: string; name: string }
export type ActivityKind = 'call' | 'sms' | 'agent';
export type ActivityState = 'ringing' | 'active' | 'ended' | 'blocked' | 'received' | 'sent' | 'running' | 'completed' | 'failed';

export interface ActivityItem {
  id: string;
  phoneId: string;
  phoneName: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  state: ActivityState;
  direction?: 'inbound' | 'outbound';
  occurredAt: string;
  durationSeconds?: number;
}

export interface ActivityLane { phoneId: string; phoneName: string; items: ActivityItem[] }
export interface TodayActivityCounts { calls: number; sms: number; agentActions: number; total: number; hourly: number[] }

/** Keeps each phone's record snapshot and live appends in one deduplicated source. */
export class ActivityFeed {
  private readonly byPhone = new Map<string, Map<string, RecordEvent>>();

  seed(phoneId: string, events: readonly RecordEvent[]): void {
    const current = this.eventsFor(phoneId);
    for (const event of events) current.set(event.eventId, event);
  }

  append(phoneId: string, event: RecordEvent): void {
    this.eventsFor(phoneId).set(event.eventId, event);
  }

  lanes(phones: readonly ActivityPhone[], now = Date.now(), perPhoneLimit = 8): ActivityLane[] {
    return phones.map((phone) => ({
      phoneId: phone.id,
      phoneName: phone.name || phone.id,
      items: projectPhoneEvents(this.byPhone.get(phone.id)?.values() ?? [], phone, now)
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.id.localeCompare(a.id))
        .slice(0, perPhoneLimit),
    }));
  }

  today(phones: readonly ActivityPhone[], from: number, to: number): TodayActivityCounts {
    const visiblePhoneIds = new Set(phones.map((phone) => phone.id));
    const starts = new Map<string, RecordEvent>();
    const smsEvents: RecordEvent[] = [];
    const toolStarts = new Map<string, RecordEvent>();
    for (const phoneId of visiblePhoneIds) {
      for (const event of this.byPhone.get(phoneId)?.values() ?? []) {
        if (event.test) continue;
        const at = Date.parse(event.occurredAt);
        if (at < from || at >= to) continue;
        if (event.type === 'call.started' || event.type === 'call.blocked') {
          const key = `${phoneId}:${event.interactionId}`;
          if (!starts.has(key)) starts.set(key, event);
        } else if (event.type === 'sms.received' || event.type === 'sms.sent') {
          smsEvents.push(event);
        } else if (event.type === 'agent.tool_started') {
          const key = `${phoneId}:${event.interactionId}`;
          if (!toolStarts.has(key)) toolStarts.set(key, event);
        }
      }
    }
    const countable = [...starts.values(), ...smsEvents, ...toolStarts.values()];
    const hourly = Array.from({ length: 24 }, () => 0);
    for (const event of countable) hourly[new Date(event.occurredAt).getHours()]++;
    const calls = starts.size;
    const sms = smsEvents.length;
    const agentActions = toolStarts.size;
    return { calls, sms, agentActions, total: calls + sms + agentActions, hourly };
  }

  private eventsFor(phoneId: string): Map<string, RecordEvent> {
    let events = this.byPhone.get(phoneId);
    if (!events) { events = new Map(); this.byPhone.set(phoneId, events); }
    return events;
  }
}

function projectPhoneEvents(events: Iterable<RecordEvent>, phone: ActivityPhone, now: number): ActivityItem[] {
  const groups = new Map<string, RecordEvent[]>();
  for (const event of events) {
    if (event.test) continue;
    const key = event.kind === 'sms' ? `sms:${event.eventId}` : `${event.kind}:${event.interactionId}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const items: ActivityItem[] = [];
  for (const rows of groups.values()) {
    rows.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.eventId.localeCompare(b.eventId));
    const first = rows[0];
    const latest = rows.at(-1)!;
    if (first.kind === 'call') {
      if (!rows.some((row) => row.type.startsWith('call.'))) continue;
      const blocked = rows.some((row) => row.type === 'call.blocked');
      const start = rows.find((row) => row.type === 'call.started') ?? first;
      const answered = rows.find((row) => row.type === 'call.answered');
      const ended = rows.find((row) => row.type === 'call.ended');
      const direction = asDirection(start.details.direction);
      const endedDuration = ended?.details.durationSeconds;
      const durationSeconds = typeof endedDuration === 'number' && Number.isFinite(endedDuration)
        ? Math.max(0, endedDuration)
        : blocked ? undefined : Math.max(0, Math.floor((now - Date.parse(answered?.occurredAt ?? start.occurredAt)) / 1000));
      items.push({
        id: first.interactionId, phoneId: phone.id, phoneName: phone.name || phone.id, kind: 'call',
        title: blocked ? 'Blocked call' : direction === 'inbound' ? 'Incoming call' : direction === 'outbound' ? 'Outgoing call' : 'Call',
        detail: firstText(start.details.contact, direction === 'inbound' ? start.details.from : start.details.to),
        state: blocked ? 'blocked' : ended ? 'ended' : answered ? 'active' : 'ringing',
        ...(direction ? { direction } : {}), occurredAt: latest.occurredAt,
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      });
      continue;
    }
    if (first.type === 'sms.received' || first.type === 'sms.sent') {
      const inbound = first.type === 'sms.received';
      const direction = inbound ? 'inbound' : 'outbound';
      items.push({
        id: first.eventId, phoneId: phone.id, phoneName: phone.name || phone.id, kind: 'sms',
        title: inbound ? 'Text received' : 'Text sent',
        detail: firstText(first.details.contact, inbound ? first.details.from : first.details.to),
        state: inbound ? 'received' : 'sent', direction, occurredAt: first.occurredAt,
      });
      continue;
    }
    if (first.type === 'agent.tool_started') {
      const toolName = firstText(first.details.toolName) || 'phone tool';
      const outcome = latest.type === 'agent.tool_finished' ? latest.details.outcome : undefined;
      items.push({
        id: first.interactionId, phoneId: phone.id, phoneName: phone.name || phone.id, kind: 'agent',
        title: `Agent · ${toolName}`, detail: outcome === 'failed' ? 'Failed' : outcome === 'completed' ? 'Completed' : 'In progress',
        state: outcome === 'failed' ? 'failed' : outcome === 'completed' ? 'completed' : 'running', occurredAt: latest.occurredAt,
      });
    }
  }
  return items;
}

function asDirection(value: unknown): 'inbound' | 'outbound' | undefined {
  return value === 'inbound' || value === 'outbound' ? value : undefined;
}

function firstText(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
  return '';
}
