import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
    expect(store.get('call_123-abc')).toEqual({ transcript, summary: null, audioAvailable: false });
    expect(() => store.audioPath('../escape')).toThrow(/invalid call recording id/);
  });

  it('merges summary metadata with an existing transcript and writes summary-only sidecars', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'timbre-call-artifacts-'));
    const store = new CallArtifactStore(dir);
    const transcript = {
      date: '2026-10-30T00:00:00.000Z', contact: 'Casey', role: 'trusted' as const, direction: 'inbound' as const,
      durationS: 3, handledBy: ['Operator'], utterances: [{ speaker: 'remote' as const, text: 'hello', startMs: 0 }],
    };

    store.writeSummary('call-with-transcript', 'Caller asked for a return call.');
    store.writeTranscript('call-with-transcript', transcript);
    expect(store.get('call-with-transcript')).toEqual({
      transcript, summary: 'Caller asked for a return call.', audioAvailable: false,
    });

    store.writeSummary('call-summary-only', 'Caller asked about opening hours.');
    expect(store.get('call-summary-only')).toEqual({
      transcript: null, summary: 'Caller asked about opening hours.', audioAvailable: false,
    });
    expect(readdirSync(dir).sort()).toEqual(['call-summary-only.json', 'call-with-transcript.json']);
  });

  it('expires WAVs and transcript sidecars on independent deadlines', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'timbre-call-artifacts-'));
    const store = new CallArtifactStore(dir);
    const now = new Date('2026-10-30T00:00:00.000Z');
    const agedFiles = [
      ['audio-old.json', 40], ['audio-old.wav', 40], ['audio-old.wav.part', 40],
      ['transcript-old.json', 70], ['summary-old.json', 70], ['transcript-old.wav', 20],
      ['recent.json', 1], ['recent.wav', 1], ['notes.txt', 365],
    ] as const;
    for (const [name, ageDays] of agedFiles) {
      const file = path.join(dir, name);
      writeFileSync(file, name === 'notes.txt' ? 'user file' : 'artifact');
      const mtime = new Date(now.getTime() - ageDays * 86_400_000);
      utimesSync(file, mtime, mtime);
    }

    expect(store.sweep({ recordings: 30, transcripts: 60 }, now)).toEqual({ recordingsRemoved: 2, transcriptsRemoved: 2 });
    expect(existsSync(path.join(dir, 'audio-old.wav'))).toBe(false);
    expect(existsSync(path.join(dir, 'audio-old.wav.part'))).toBe(false);
    expect(existsSync(path.join(dir, 'audio-old.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'transcript-old.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'summary-old.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'transcript-old.wav'))).toBe(true);
    expect(existsSync(path.join(dir, 'recent.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'recent.wav'))).toBe(true);
    expect(existsSync(path.join(dir, 'notes.txt'))).toBe(true);
  });

  it('expires orphaned atomic-write sidecars after one hour and leaves recent or unrelated temp files', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'timbre-call-artifacts-'));
    const store = new CallArtifactStore(dir);
    const now = new Date('2026-10-30T00:00:00.000Z');
    const files = [
      ['.call-old.00000000-0000-4000-8000-000000000001.tmp', 2 * 60],
      ['.call-recent.00000000-0000-4000-8000-000000000002.tmp', 30],
      ['notes.00000000-0000-4000-8000-000000000003.tmp', 2 * 60],
    ] as const;
    for (const [name, ageMinutes] of files) {
      const file = path.join(dir, name);
      writeFileSync(file, 'partial sidecar');
      const mtime = new Date(now.getTime() - ageMinutes * 60_000);
      utimesSync(file, mtime, mtime);
    }

    expect(store.sweep({ recordings: 30, transcripts: 60 }, now)).toEqual({ recordingsRemoved: 0, transcriptsRemoved: 1 });
    expect(existsSync(path.join(dir, files[0][0]))).toBe(false);
    expect(existsSync(path.join(dir, files[1][0]))).toBe(true);
    expect(existsSync(path.join(dir, files[2][0]))).toBe(true);
  });

  it('uses an earlier transcript retention cutoff for atomic-write sidecars', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'timbre-call-artifacts-'));
    const store = new CallArtifactStore(dir);
    const now = new Date('2026-10-30T00:00:00.000Z');
    const stale = '.call-short-old.00000000-0000-4000-8000-000000000004.tmp';
    const recent = '.call-short-recent.00000000-0000-4000-8000-000000000005.tmp';
    for (const [name, ageMinutes] of [[stale, 2], [recent, 0.5]] as const) {
      const file = path.join(dir, name);
      writeFileSync(file, 'partial sidecar');
      const mtime = new Date(now.getTime() - ageMinutes * 60_000);
      utimesSync(file, mtime, mtime);
    }

    expect(store.sweep({ recordings: 30, transcripts: 0.001 }, now)).toEqual({ recordingsRemoved: 0, transcriptsRemoved: 1 });
    expect(existsSync(path.join(dir, stale))).toBe(false);
    expect(existsSync(path.join(dir, recent))).toBe(true);
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

  it('keeps completed artifacts but still expires temp sidecars when retention is disabled', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'timbre-call-artifacts-'));
    const store = new CallArtifactStore(dir);
    const staleTemp = '.keep-temp.00000000-0000-4000-8000-000000000006.tmp';
    writeFileSync(path.join(dir, 'keep.json'), 'transcript');
    writeFileSync(path.join(dir, 'keep.wav'), 'audio');
    const tempFile = path.join(dir, staleTemp);
    writeFileSync(tempFile, 'partial sidecar');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(tempFile, old, old);

    expect(store.sweep({ recordings: 0, transcripts: 0 }, new Date())).toEqual({ recordingsRemoved: 0, transcriptsRemoved: 1 });
    expect(existsSync(path.join(dir, 'keep.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'keep.wav'))).toBe(true);
    expect(existsSync(tempFile)).toBe(false);
  });
});
