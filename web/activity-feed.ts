import type { RecordEvent } from './api';

export interface ActivityPhone { id: string; name: string }
export interface TodayActivityCounts { calls: number; sms: number; total: number; hourly: number[] }

/** Deduplicates saved and streamed events for the Switchboard's daily totals. */
export class ActivityFeed {
  private readonly byPhone = new Map<string, Map<string, RecordEvent>>();

  seed(phoneId: string, events: readonly RecordEvent[]): void {
    for (const event of events) this.eventsFor(phoneId).set(event.eventId, event);
  }

  append(phoneId: string, event: RecordEvent): void {
    this.eventsFor(phoneId).set(event.eventId, event);
  }

  today(phones: readonly ActivityPhone[], from: number, to: number): TodayActivityCounts {
    const calls = new Set<string>();
    let sms = 0;
    const hourly = Array.from({ length: 24 }, () => 0);
    for (const phone of phones) {
      for (const event of this.byPhone.get(phone.id)?.values() ?? []) {
        if (event.test) continue;
        const at = Date.parse(event.occurredAt);
        if (at < from || at >= to) continue;
        if (event.type === 'call.started' || event.type === 'call.blocked') {
          const key = `${phone.id}:${event.interactionId}`;
          if (calls.has(key)) continue;
          calls.add(key);
        } else if (event.type === 'sms.received' || event.type === 'sms.sent') {
          sms++;
        } else continue;
        hourly[new Date(at).getHours()]++;
      }
    }
    return { calls: calls.size, sms, total: calls.size + sms, hourly };
  }

  private eventsFor(phoneId: string): Map<string, RecordEvent> {
    let events = this.byPhone.get(phoneId);
    if (!events) { events = new Map(); this.byPhone.set(phoneId, events); }
    return events;
  }
}
