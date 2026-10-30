import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CallArtifactStore, type CallTranscript } from '../src/records/call-artifacts.js';
import type { RecordEvent } from '../src/records/event-types.js';
import { JsonlEventStore } from '../src/records/jsonl-event-store.js';
import { RecordSearchIndex } from '../src/records/record-search-index.js';

const roots: string[] = [];
const indexes: RecordSearchIndex[] = [];
afterEach(() => {
  for (const index of indexes.splice(0)) index.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'timbre-search-'));
  roots.push(dir);
  return dir;
}

function index(dataDir: string, log: (message: string) => void = () => {}): RecordSearchIndex {
  const result = new RecordSearchIndex(dataDir, log);
  indexes.push(result);
  return result;
}

function sms(eventId: string, interactionId: string, text: string, at = '2026-10-29T10:00:00.000Z'): RecordEvent {
  return {
    eventId, interactionId, kind: 'sms', type: 'sms.received', occurredAt: at,
    details: { text, contact: 'Jordan Lee', from: '+61412345678', direction: 'inbound' },
  };
}

function transcript(text: string): CallTranscript {
  return {
    date: '2026-10-29T11:00:00.000Z', contact: 'Alex Morgan', role: 'caller', direction: 'inbound',
    durationS: 30, handledBy: [], utterances: [{ speaker: 'remote', text, startMs: 0 }],
  };
}

describe('record search index', () => {
  it('indexes SMS and transcripts per phone, with AND terms and exact quoted phrases', async () => {
    const dir = root();
    const events = new JsonlEventStore(dir);
    events.append('home', sms('sms-home', 'sms-home', 'Call me on 0412 345 678 after green tea'));
    events.append('home', sms('sms-home-compact', 'sms-home-compact', 'Call me on 0412345678 tomorrow'));
    events.append('work', sms('sms-work', 'sms-work', 'A different work message'));
    new CallArtifactStore(path.join(dir, 'phones', 'home', 'recordings')).writeTranscript('call-home', transcript('Green tea tomorrow, around 09:45.'));
    const search = index(dir);

    await search.warmPhone('home');
    await search.warmPhone('work');

    expect(search.search('home', '0412 345').items.map((item) => item.id).sort()).toEqual(['sms-home', 'sms-home-compact']);
    expect(search.search('home', '0412 345 678').items.map((item) => item.id).sort()).toEqual(['sms-home', 'sms-home-compact']);
    expect(search.search('home', '0412345678').items.map((item) => item.id).sort()).toEqual(['sms-home', 'sms-home-compact']);
    expect(search.search('home', '"0412 345 678"').items.map((item) => item.id).sort()).toEqual(['sms-home', 'sms-home-compact']);
    expect(search.search('home', '0412345678').items.every((item) => item.snippet.includes('0412'))).toBe(true);
    expect(search.search('home', 'green tomorrow').items.map((item) => item.id)).toEqual(['call-home']);
    expect(search.search('home', '"green tea"').items.map((item) => item.id)).toEqual(['call-home', 'sms-home']);
    expect(search.search('home', '"tea green"').items).toEqual([]);
    expect(search.search('work', '0412 345').items).toEqual([]);
  });

  it('reports indexing until asynchronous warm-up finishes', async () => {
    const dir = root();
    new JsonlEventStore(dir).append('home', sms('sms-1', 'sms-1', 'warmup needle'));
    const search = index(dir);

    const warming = search.warmPhone('home');
    expect(search.search('home', 'needle')).toEqual({ status: 'indexing', items: [] });
    await warming;
    expect(search.search('home', 'needle').status).toBe('ready');
  });

  it('updates on append and transcript write, then removes expired transcripts', async () => {
    const dir = root();
    const events = new JsonlEventStore(dir);
    const recordingsDir = path.join(dir, 'phones', 'home', 'recordings');
    const artifacts = new CallArtifactStore(recordingsDir);
    const search = index(dir);
    await search.warmPhone('home');

    events.append('home', sms('sms-1', 'sms-1', 'fresh message 021234567'));
    artifacts.writeTranscript('call-1', transcript('purgeable conversation'));
    expect(search.search('home', '021234567').items.map((item) => item.id)).toEqual(['sms-1']);
    expect(search.search('home', 'purgeable').items.map((item) => item.id)).toEqual(['call-1']);

    const old = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(path.join(recordingsDir, 'call-1.json'), old, old);
    expect(artifacts.sweep({ recordings: 7, transcripts: 1 }, new Date())).toMatchObject({ transcriptsRemoved: 1 });
    expect(search.search('home', 'purgeable').items).toEqual([]);
  });

  it('resumes store notifications after a server listener restarts', async () => {
    const dir = root();
    const events = new JsonlEventStore(dir);
    const search = index(dir);
    await search.warmPhone('home');
    search.dispose();
    search.start();

    events.append('home', sms('sms-after-rebind', 'sms-after-rebind', 'after rebind'));
    await search.warmPhone('home');

    expect(search.search('home', 'rebind').items.map((item) => item.id)).toEqual(['sms-after-rebind']);
  });

  it('searches 10,000 indexed events under 200 ms', async () => {
    const dir = root();
    const eventsDir = path.join(dir, 'phones', 'home', 'events');
    mkdirSync(eventsDir, { recursive: true });
    const rows = Array.from({ length: 10_000 }, (_, i) => JSON.stringify(sms(`sms-${i}`, `sms-${i}`, `common record ${i} ${i === 9_999 ? 'needle' : ''}`)));
    writeFileSync(path.join(eventsDir, '2026-10-29.jsonl'), `${rows.join('\n')}\n`, 'utf8');
    const search = index(dir);
    await search.warmPhone('home');

    const started = performance.now();
    const result = search.search('home', 'common record');
    const elapsed = performance.now() - started;

    expect(result.items).toHaveLength(50);
    expect(elapsed).toBeLessThan(200);
  });

  it('keeps only the newest 20,000 documents for a phone', async () => {
    const dir = root();
    const eventsDir = path.join(dir, 'phones', 'home', 'events');
    mkdirSync(eventsDir, { recursive: true });
    const rows = Array.from({ length: 20_001 }, (_, i) => JSON.stringify(sms(
      'sms-' + i, 'sms-' + i, i === 0 ? 'newestneedle' : i === 20_000 ? 'oldestneedle' : 'ordinary record',
      new Date(Date.UTC(2026, 0, 1) + (20_000 - i) * 1000).toISOString(),
    )));
    writeFileSync(path.join(eventsDir, '2026-10-29.jsonl'), rows.join('\n') + '\n', 'utf8');
    const search = index(dir);
    await search.warmPhone('home');

    expect(search.search('home', 'oldestneedle').items).toEqual([]);
    expect(search.search('home', 'newestneedle').items.map((item) => item.id)).toEqual(['sms-0']);
  });

  it('logs warm-up failures and keeps the phone in indexing state', async () => {
    const messages: string[] = [];
    const search = index(path.join(root(), 'missing'), (message) => messages.push(message));

    await search.warmPhone('../invalid');

    expect(search.search('../invalid', 'needle').status).toBe('indexing');
    expect(messages.length).toBeGreaterThan(0);
  });
});
