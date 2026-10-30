import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../src/config/timbre-config.js';
import { RecordingRetentionJob } from '../src/records/recording-retention-job.js';
import { JsonlEventStore } from '../src/records/jsonl-event-store.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agedFile(file: string, ageDays: number, now: Date, content = 'data'): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  const mtime = new Date(now.getTime() - ageDays * 86_400_000);
  utimesSync(file, mtime, mtime);
}

describe('RecordingRetentionJob', () => {
  it('isolates stamped exports in a shared custom folder and keeps unstamped legacy files', async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), 'timbre-retention-shared-'));
    dirs.push(baseDir);
    const dataDir = path.join(baseDir, 'data');
    const shared = path.join(baseDir, 'shared-transcripts');
    const now = new Date('2026-10-30T00:00:00.000Z');
    const [first] = defaultConfig().phones;
    const phone = (id: string, retentionDays: number) => ({
      ...first, id, line: {
        ...first.line,
        transcripts: { ...first.line.transcripts, folder: shared, retentionDays },
      },
    });
    const phones = [phone('phone-a', 10), phone('phone-b', 30)];
    agedFile(path.join(shared, 'phone-a.md'), 20, now, '---\ngenerator: helm-phone-transcript\nphone_id: "phone-a"\n---\n');
    agedFile(path.join(shared, 'phone-b.md'), 20, now, '---\ngenerator: helm-phone-transcript\nphone_id: "phone-b"\n---\n');
    agedFile(path.join(shared, 'legacy.md'), 365, now, '---\ngenerator: helm-phone-transcript\n---\n');
    const job = new RecordingRetentionJob({ dataDir, getPhones: () => phones, now: () => now, recordEvent: () => undefined });

    await job.sweep();

    expect(existsSync(path.join(shared, 'phone-a.md'))).toBe(false);
    expect(existsSync(path.join(shared, 'phone-b.md'))).toBe(true);
    expect(existsSync(path.join(shared, 'legacy.md'))).toBe(true);
  });

  it('shares one in-flight sweep between overlapping calls', async () => {
    const phone = defaultConfig().phones[0];
    const job = new RecordingRetentionJob({
      dataDir: os.tmpdir(), getPhones: () => [phone], recordEvent: () => undefined,
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(job as unknown as { sweepPhones: () => Promise<void> }, 'sweepPhones').mockReturnValue(pending);

    const first = job.sweep();
    const second = job.sweep();
    expect(second).toBe(first);
    finish();
    await first;
  });

  it('purges each configured phone by type, including disabled phones, and records per-phone counts', async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), 'timbre-retention-'));
    dirs.push(baseDir);
    const dataDir = path.join(baseDir, 'data');
    mkdirSync(dataDir);
    const now = new Date('2026-10-30T00:00:00.000Z');
    const [first] = defaultConfig().phones;
    const phones = [
      { ...first, id: '../../outside', line: { ...first.line, recordings: { retentionDays: 1 } } },
      { ...first, id: 'phone-one', line: { ...first.line, recordings: { retentionDays: 30 }, transcripts: { ...first.line.transcripts, retentionDays: 60 } } },
      { ...first, id: 'phone-two', line: { ...first.line, enabled: false, recordings: { retentionDays: 60 }, transcripts: { ...first.line.transcripts, retentionDays: 30 } } },
    ];
    const outsideAudio = path.join(baseDir, 'outside', 'recordings', 'old.wav');
    agedFile(outsideAudio, 40, now);
    for (const phone of phones) {
      const root = path.join(dataDir, 'phones', phone.id);
      agedFile(path.join(root, 'recordings', 'old.wav'), 40, now);
      agedFile(path.join(root, 'recordings', 'old.json'), 40, now);
    }
    const secondTranscripts = path.join(dataDir, 'phones', 'phone-two', 'transcripts');
    agedFile(path.join(secondTranscripts, 'old.md'), 40, now, '---\ngenerator: helm-phone-transcript\n---\n');
    agedFile(path.join(secondTranscripts, 'notes.md'), 365, now, '# keep');
    const logs: string[] = [];
    const eventStore = new JsonlEventStore(dataDir, (text) => logs.push(text));
    const job = new RecordingRetentionJob({
      dataDir, getPhones: () => phones, now: () => now,
      recordEvent: (phoneId, event) => eventStore.append(phoneId, event), log: (text) => logs.push(text),
    });

    await job.sweep();

    const file = (phoneId: string, name: string) => path.join(dataDir, 'phones', phoneId, 'recordings', name);
    expect(existsSync(file('phone-one', 'old.wav'))).toBe(false);
    expect(existsSync(file('phone-one', 'old.json'))).toBe(true);
    expect(existsSync(file('phone-two', 'old.wav'))).toBe(true);
    expect(existsSync(file('phone-two', 'old.json'))).toBe(false);
    expect(existsSync(outsideAudio)).toBe(true);
    expect(existsSync(path.join(secondTranscripts, 'old.md'))).toBe(false);
    expect(existsSync(path.join(secondTranscripts, 'notes.md'))).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('recording retention failed for phone ../../outside');
    expect(eventStore.readEvents('phone-one').map(({ type, details }) => [type, details])).toEqual([
      ['retention.purged', { recordingsRemoved: 1, transcriptsRemoved: 0 }],
    ]);
    expect(eventStore.readEvents('phone-two').map(({ type, details }) => [type, details])).toEqual([
      ['retention.purged', { recordingsRemoved: 0, transcriptsRemoved: 2 }],
    ]);
  });

  it('runs immediately and daily until stopped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T00:00:00.000Z'));
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'timbre-retention-timer-'));
    dirs.push(dataDir);
    const phone = defaultConfig().phones[0];
    agedFile(path.join(dataDir, 'phones', phone.id, 'recordings', 'near-expiry.wav'), 28, new Date(), 'audio');
    let reads = 0;
    const job = new RecordingRetentionJob({
      dataDir, getPhones: () => { reads++; return [phone]; }, now: () => new Date(),
      recordEvent: () => undefined, log: () => undefined,
    });

    await job.start();
    expect(reads).toBe(1);
    await job.start();
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(reads).toBe(2);
    await job.stop();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
    expect(reads).toBe(2);
  });
});
