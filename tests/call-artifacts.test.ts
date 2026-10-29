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

  it('expires WAV, sidecar, and unfinished part together while preserving recent files', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'timbre-call-artifacts-'));
    const store = new CallArtifactStore(dir);
    const old = ['old-call.json', 'old-call.wav', 'old-call.wav.part'];
    for (const name of old) writeFileSync(path.join(dir, name), 'old');
    writeFileSync(path.join(dir, 'recent-call.wav'), 'new');
    const oldTime = new Date('2026-01-01T00:00:00.000Z');
    for (const name of old) utimesSync(path.join(dir, name), oldTime, oldTime);

    expect(store.sweep(30, new Date('2026-10-30T00:00:00.000Z'))).toBe(3);
    expect(old.every((name) => !existsSync(path.join(dir!, name)))).toBe(true);
    expect(existsSync(path.join(dir, 'recent-call.wav'))).toBe(true);
  });
});
