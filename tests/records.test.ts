import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlEventStore } from '../src/records/jsonl-event-store.js';
import { RecordQuery } from '../src/records/record-query.js';
import type { RecordEvent } from '../src/records/event-types.js';
import { localDateRangeToUtc, presetRange } from '../web/record-date-range.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(path.join(tmpdir(), 'timbre-records-')); roots.push(dir); return dir; };
function event(eventId: string, interactionId: string, type: RecordEvent['type'], occurredAt: string, details: Record<string, unknown> = {}, kind: RecordEvent['kind'] = 'call'): RecordEvent {
  return { eventId, interactionId, kind, type, occurredAt, details };
}

describe('JSONL event store', () => {
  it('keeps per-phone events isolated and filters UTC instants across UTC midnight', () => {
    const store = new JsonlEventStore(root());
    store.append('home', event('before', 'c1', 'call.started', '2026-10-29T12:59:59.000Z'));
    store.append('home', event('start', 'c2', 'call.started', '2026-10-29T13:00:00.000Z'));
    store.append('home', event('end', 'c2', 'call.ended', '2026-10-30T12:59:59.000Z'));
    store.append('home', event('after', 'c3', 'call.started', '2026-10-30T13:00:00.000Z'));
    store.append('work', event('other-phone', 'c2', 'call.started', '2026-10-29T15:00:00.000Z'));

    expect(store.readEvents('home', { from: '2026-10-29T13:00:00.000Z', to: '2026-10-30T13:00:00.000Z' }).map((item) => item.eventId)).toEqual(['start', 'end']);
    expect(store.readEvents('work').map((item) => item.eventId)).toEqual(['other-phone']);
  });

  it('persists call outcomes in the same phone-scoped event stream', () => {
    const store = new JsonlEventStore(root());
    const outcome = event('outcome', 'call-1', 'call.outcome', '2026-10-29T13:00:00.000Z', {
      outcome: 'spam', source: 'agent',
    });

    store.append('home', outcome);

    expect(store.readEvents('home')).toEqual([outcome]);
    expect(store.readEvents('work')).toEqual([]);
  });

  it('skips and logs corrupt JSONL rows and a torn trailing line', () => {
    const dir = root();
    const messages: string[] = [];
    const store = new JsonlEventStore(dir, (message) => messages.push(message));
    store.append('home', event('valid', 'c1', 'call.started', '2026-10-29T13:00:00.000Z'));
    appendFileSync(path.join(dir, 'phones', 'home', 'events', '2026-10-29.jsonl'), '{}\n{"eventId":"torn"');

    expect(store.readEvents('home').map((item) => item.eventId)).toEqual(['valid']);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/corrupt.*2026-10-29\.jsonl/i);

    store.append('home', event('after-recovery', 'c2', 'call.started', '2026-10-29T14:00:00.000Z'));
    expect(store.readEvents('home').map((item) => item.eventId)).toEqual(['valid', 'after-recovery']);
  });

  it('projects ordered timelines and pages records with a stable cursor', () => {
    const store = new JsonlEventStore(root());
    store.append('home', event('call-start', 'call-1', 'call.started', '2026-10-29T10:00:00.000Z', { direction: 'inbound', contact: 'Mum' }));
    store.append('home', event('policy', 'call-1', 'policy.evaluated', '2026-10-29T10:00:01.000Z', { action: 'call.in', allowed: true }));
    store.append('home', event('call-end', 'call-1', 'call.ended', '2026-10-29T10:05:00.000Z', { durationSeconds: 300 }));
    store.append('home', event('sms', 'sms-1', 'sms.received', '2026-10-29T11:00:00.000Z', { text: '<img onerror=alert(1)>' }, 'sms'));
    store.append('home', event('call-2', 'call-2', 'call.started', '2026-10-29T12:00:00.000Z'));
    const query = new RecordQuery(store);

    const first = query.list('home', { from: '2026-10-29T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z', limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(['call-2', 'sms-1']);
    expect(first.nextCursor).toBeTruthy();
    const second = query.list('home', { from: '2026-10-29T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z', limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(['call-1']);
    expect(second.items[0].events.map((item) => item.eventId)).toEqual(['call-start', 'policy', 'call-end']);
    expect(second.items[0].durationSeconds).toBe(300);
    expect(query.get('home', 'sms-1')?.events[0].details.text).toBe('<img onerror=alert(1)>');
  });

  it('names every party of a conference call, so old records list them too', () => {
    const store = new JsonlEventStore(root());
    store.append('home', event('s', 'conf', 'call.started', '2026-11-08T10:00:00.000Z', { direction: 'outbound', contact: 'Octavio' }));
    store.append('home', event('a', 'conf', 'conference.added', '2026-11-08T10:00:30.000Z', { contact: 'Oscar' }));
    store.append('home', event('b', 'conf', 'conference.added', '2026-11-08T10:01:00.000Z', { contact: 'Oscar' }));

    expect(new RecordQuery(store).get('home', 'conf')?.contact).toBe('Octavio, Oscar');
  });
});

describe('local date range conversion', () => {
  it('converts inclusive local dates into UTC start and exclusive end across UTC midnight', () => {
    const oldTimeZone = process.env.TZ;
    process.env.TZ = 'Australia/Sydney';
    try {
      expect(localDateRangeToUtc('2026-10-30', '2026-10-30')).toEqual({
        from: '2026-10-29T13:00:00.000Z',
        to: '2026-10-30T13:00:00.000Z',
      });
    } finally {
      if (oldTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = oldTimeZone;
    }
  });
});

describe('local date range presets', () => {
  it.each([
    { preset: 'today', reference: new Date(2026, 9, 5), expected: { fromDate: '2026-10-05', toDate: '2026-10-05' } },
    { preset: 'yesterday', reference: new Date(2026, 9, 5), expected: { fromDate: '2026-10-04', toDate: '2026-10-04' } },
    { preset: '7-days', reference: new Date(2026, 9, 5), expected: { fromDate: '2026-09-29', toDate: '2026-10-05' } },
    { preset: '30-days', reference: new Date(2026, 9, 5), expected: { fromDate: '2026-09-06', toDate: '2026-10-05' } },
  ] as const)('returns the inclusive local dates for $preset', ({ preset, reference, expected }) => {
    expect(presetRange(preset, reference)).toEqual(expected);
  });

  it('uses calendar arithmetic across year boundaries without mutating the reference date', () => {
    const reference = new Date(2024, 0, 3, 0, 0);
    const time = reference.getTime();

    expect(presetRange('7-days', reference)).toEqual({ fromDate: '2023-12-28', toDate: '2024-01-03' });
    expect(presetRange('30-days', new Date(2024, 2, 1))).toEqual({ fromDate: '2024-02-01', toDate: '2024-03-01' });
    expect(reference.getTime()).toBe(time);
  });

  it('counts local calendar days across a daylight-saving transition', () => {
    const previousTimeZone = process.env.TZ;
    process.env.TZ = 'Australia/Sydney';
    try {
      const reference = new Date(2026, 9, 5, 0, 0);
      expect(presetRange('7-days', reference)).toEqual({ fromDate: '2026-09-29', toDate: '2026-10-05' });
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimeZone;
    }
  });
});
