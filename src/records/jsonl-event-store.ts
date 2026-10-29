import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { RecordDateRange, RecordEvent, RecordEventKind, RecordEventType } from './event-types.js';

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const EVENT_KINDS: ReadonlySet<string> = new Set(['call', 'sms', 'system'] satisfies RecordEventKind[]);
const EVENT_TYPES: ReadonlySet<string> = new Set([
  'contact.matched', 'call.started', 'call.blocked', 'call.answered', 'call.ended', 'call.transferred',
  'call.agent_started', 'conference.added', 'sms.received', 'sms.sent', 'policy.evaluated', 'notification.sent',
] satisfies RecordEventType[]);

export class JsonlEventStore {
  constructor(private readonly dataDir: string, private readonly log: (message: string) => void = () => {}) {}

  append(phoneId: string, event: RecordEvent): void {
    this.validatePhoneId(phoneId);
    if (!isRecordEvent(event)) throw new Error('record event has an invalid shape');
    const date = new Date(event.occurredAt).toISOString().slice(0, 10);
    const dir = this.eventsDir(phoneId);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${date}.jsonl`);
    const separator = existsSync(file) && this.hasUnterminatedTail(file) ? '\n' : '';
    appendFileSync(file, `${separator}${JSON.stringify(event)}\n`, 'utf8');
  }

  readEvents(phoneId: string, range: RecordDateRange = {}): RecordEvent[] {
    this.validatePhoneId(phoneId);
    const from = range.from === undefined ? undefined : this.parseBound(range.from, 'from');
    const to = range.to === undefined ? undefined : this.parseBound(range.to, 'to');
    if (from !== undefined && to !== undefined && from >= to) throw new Error('from must be earlier than to');
    const dir = this.eventsDir(phoneId);
    if (!existsSync(dir)) return [];
    const events: RecordEvent[] = [];
    const files = readdirSync(dir).filter((name) => DAY_FILE.test(name)).sort();
    for (const name of files) {
      const day = DAY_FILE.exec(name)![1];
      if (!this.dayMayOverlap(day, from, to)) continue;
      const content = readFileSync(path.join(dir, name), 'utf8');
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const value: unknown = JSON.parse(line);
          if (!isRecordEvent(value)) throw new Error('invalid record shape');
          const event = value;
          const at = Date.parse(event.occurredAt);
          if ((from === undefined || at >= from) && (to === undefined || at < to)) events.push(event);
        } catch {
          try { this.log(`skipping corrupt record line in ${name}`); } catch { /* recovery must not depend on the logger */ }
        }
      }
    }
    return events;
  }

  private eventsDir(phoneId: string): string { return path.join(this.dataDir, 'phones', phoneId, 'events'); }

  private validatePhoneId(phoneId: string): void {
    if (!/^[\w-]+$/.test(phoneId)) throw new Error('invalid phone id');
  }

  private parseBound(value: string, name: string): number {
    const at = Date.parse(value);
    if (!Number.isFinite(at) || !value.endsWith('Z')) throw new Error(`invalid UTC ${name} bound`);
    return at;
  }

  private dayMayOverlap(day: string, from?: number, to?: number): boolean {
    const start = Date.parse(`${day}T00:00:00.000Z`);
    const end = start + 86_400_000;
    return (from === undefined || end > from) && (to === undefined || start < to);
  }

  private hasUnterminatedTail(file: string): boolean {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      if (!size) return false;
      const tail = Buffer.alloc(1);
      const length = readSync(fd, tail, 0, 1, size - 1);
      return length === 1 && tail[0] !== 10;
    } finally { closeSync(fd); }
  }
}

function isRecordEvent(value: unknown): value is RecordEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<RecordEvent>;
  return typeof event.eventId === 'string' && !!event.eventId
    && typeof event.interactionId === 'string' && !!event.interactionId
    && typeof event.kind === 'string' && EVENT_KINDS.has(event.kind)
    && typeof event.type === 'string' && EVENT_TYPES.has(event.type)
    && typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt))
    && !!event.details && typeof event.details === 'object' && !Array.isArray(event.details);
}
