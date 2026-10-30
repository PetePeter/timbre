import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CallArtifactStore } from '../src/records/call-artifacts.js';

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('CallArtifactStore', () => {
  it('stores a transcript by safe interaction id and rejects path-like ids', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'timbre-call-artifacts-'));
    const store = new CallArtifactStore(dir);
    const transcript = {
      date: '2026-10-30T00:00:00.000Z', contact: 'Me', role: 'owner' as const, direction: 'inbound' as const,
      durationS: 3, handledBy: ['Operator'], utterances: [{ speaker: 'remote' as const, text: 'hello', startMs: 0 }],
    };
    store.writeTranscript('call_123-abc', transcript);
    expect(store.get('call_123-abc')).toEqual({ transcript, audioAvailable: false });
    expect(() => store.audioPath('../escape')).toThrow(/invalid call recording id/);
  });

  it('expires WAVs and transcript sidecars on independent deadlines', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'timbre-call-artifacts-'));
    const store = new CallArtifactStore(dir);
    const now = new Date('2026-10-30T00:00:00.000Z');
    const agedFiles = [
      ['audio-old.json', 40], ['audio-old.wav', 40], ['audio-old.wav.part', 40],
      ['transcript-old.json', 70], ['transcript-old.wav', 20],
      ['recent.json', 1], ['recent.wav', 1], ['notes.txt', 365],
    ] as const;
    for (const [name, ageDays] of agedFiles) {
      const file = path.join(dir, name);
      writeFileSync(file, name === 'notes.txt' ? 'user file' : 'artifact');
      const mtime = new Date(now.getTime() - ageDays * 86_400_000);
      utimesSync(file, mtime, mtime);
    }

    expect(store.sweep({ recordings: 30, transcripts: 60 }, now)).toEqual({ recordingsRemoved: 2, transcriptsRemoved: 1 });
    expect(existsSync(path.join(dir, 'audio-old.wav'))).toBe(false);
    expect(existsSync(path.join(dir, 'audio-old.wav.part'))).toBe(false);
    expect(existsSync(path.join(dir, 'audio-old.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'transcript-old.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'transcript-old.wav'))).toBe(true);
    expect(existsSync(path.join(dir, 'recent.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'recent.wav'))).toBe(true);
    expect(existsSync(path.join(dir, 'notes.txt'))).toBe(true);
  });

  it('keeps artifacts when a retention value is not finite', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'timbre-call-artifacts-'));
    const store = new CallArtifactStore(dir);
    writeFileSync(path.join(dir, 'keep.json'), 'transcript');
    writeFileSync(path.join(dir, 'keep.wav'), 'audio');

    expect(store.sweep({ recordings: Number.NaN, transcripts: Number.POSITIVE_INFINITY }, new Date())).toEqual({ recordingsRemoved: 0, transcriptsRemoved: 0 });
    expect(existsSync(path.join(dir, 'keep.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'keep.wav'))).toBe(true);
  });

  it('keeps artifacts when retention is disabled with zero days', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'timbre-call-artifacts-'));
    const store = new CallArtifactStore(dir);
    writeFileSync(path.join(dir, 'keep.json'), 'transcript');
    writeFileSync(path.join(dir, 'keep.wav'), 'audio');

    expect(store.sweep({ recordings: 0, transcripts: 0 }, new Date())).toEqual({ recordingsRemoved: 0, transcriptsRemoved: 0 });
    expect(existsSync(path.join(dir, 'keep.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'keep.wav'))).toBe(true);
  });
});
