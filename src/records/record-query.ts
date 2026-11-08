import type { RecordEvent, RecordPage, RecordQueryOptions, RecordSummary } from './event-types.js';
import { JsonlEventStore } from './jsonl-event-store.js';

interface Cursor { at: string; id: string }

export class RecordQuery {
  constructor(private readonly store: JsonlEventStore) {}

  list(phoneId: string, options: RecordQueryOptions = {}): RecordPage {
    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
    const cursor = options.cursor ? this.decodeCursor(options.cursor) : undefined;
    const summaries = this.project(this.store.readEvents(phoneId, options))
      .filter((item) => this.matchesFilter(item, options.filter ?? 'all'))
      .sort(compareSummary);
    const after = cursor ? summaries.filter((item) => compareSummary(item, cursorAsSummary(cursor)) > 0) : summaries;
    const items = after.slice(0, limit);
    const hasMore = after.length > items.length;
    return { items, nextCursor: hasMore ? this.encodeCursor(items.at(-1)!) : null };
  }

  get(phoneId: string, interactionId: string): RecordSummary | null {
    const events = this.store.readEvents(phoneId).filter((event) => event.interactionId === interactionId);
    return this.project(events)[0] ?? null;
  }

  private project(events: RecordEvent[]): RecordSummary[] {
    const groups = new Map<string, RecordEvent[]>();
    for (const event of events) {
      const group = groups.get(event.interactionId) ?? [];
      group.push(event);
      groups.set(event.interactionId, group);
    }
    return [...groups].map(([id, rows]) => this.summary(id, rows));
  }

  private summary(id: string, rows: RecordEvent[]): RecordSummary {
    rows.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const first = rows[0];
    const latest = rows.at(-1)!;
    const start = rows.find((item) => item.type === 'call.started' || item.type === 'call.blocked' || item.type === 'sms.received' || item.type === 'sms.sent') ?? first;
    const ended = rows.find((item) => item.type === 'call.ended');
    const duration = ended?.details.durationSeconds;
    const details = start.details;
    return {
      id, kind: start.kind, occurredAt: start.occurredAt, lastEventAt: latest.occurredAt,
      contact: partyLabel(details.contact, rows), from: asString(details.from), to: asString(details.to),
      direction: details.direction === 'inbound' || details.direction === 'outbound' ? details.direction : undefined,
      action: asString(latest.details.action) ?? latest.type,
      durationSeconds: typeof duration === 'number' ? duration : undefined,
      hasConference: rows.some((item) => item.type === 'conference.added'),
      blocked: rows.some((item) => item.type === 'call.blocked'),
      events: rows,
    };
  }

  private matchesFilter(item: RecordSummary, filter: NonNullable<RecordQueryOptions['filter']>): boolean {
    if (filter === 'all') return true;
    if (filter === 'calls') return item.kind === 'call';
    if (filter === 'sms') return item.kind === 'sms';
    if (filter === 'conferences') return item.hasConference;
    return item.blocked;
  }

  private encodeCursor(item: RecordSummary): string {
    return Buffer.from(JSON.stringify({ at: item.lastEventAt, id: item.id })).toString('base64url');
  }

  private decodeCursor(value: string): Cursor {
    try {
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
      if (!Number.isFinite(Date.parse(cursor.at)) || typeof cursor.id !== 'string') throw new Error();
      return cursor;
    } catch { throw new Error('invalid record cursor'); }
  }
}

function asString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }

function cursorAsSummary(cursor: Cursor): RecordSummary {
  return { id: cursor.id, kind: 'system', occurredAt: cursor.at, lastEventAt: cursor.at, action: '', hasConference: false, blocked: false, events: [] };
}

function compareSummary(a: RecordSummary, b: RecordSummary): number {
  return Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt) || b.id.localeCompare(a.id);
}

/** A conference lists everyone: the first contact, then each one added. */
function partyLabel(first: unknown, rows: RecordEvent[]): string | undefined {
  const added = rows.filter((row) => row.type === 'conference.added').map((row) => asString(row.details.contact));
  const names = [...new Set([asString(first), ...added].filter((name): name is string => !!name))];
  return names.length ? names.join(', ') : undefined;
}
