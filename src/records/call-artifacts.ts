import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ARTIFACT = /^([A-Za-z0-9_-]{1,128})\.(json|wav|wav\.part)$/;
const TEMP_SIDECAR = /^\.[A-Za-z0-9_-]{1,128}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const DAY_MS = 86_400_000;
const MAX_TEMP_SIDECAR_AGE_MS = 60 * 60 * 1000;

export interface CallArtifactRetention { recordings: number; transcripts: number }
export interface CallArtifactSweepResult { recordingsRemoved: number; transcriptsRemoved: number }

export interface CallTranscript {
  date: string;
  contact: string;
  role: string;
  direction: 'inbound' | 'outbound';
  durationS: number;
  handledBy: string[];
  utterances: Array<{ speaker: 'local' | 'remote'; text: string; startMs: number }>;
}

export interface CallArtifacts {
  transcript: CallTranscript | null;
  summary: string | null;
  audioAvailable: boolean;
}

type TranscriptWrittenListener = (directory: string, interactionId: string, transcript: CallTranscript) => void;
type TranscriptPurgedListener = (directory: string, interactionId: string) => void;
const transcriptWrittenListeners = new Set<TranscriptWrittenListener>();
const transcriptPurgedListeners = new Set<TranscriptPurgedListener>();

export function subscribeTranscriptWritten(listener: TranscriptWrittenListener): () => void {
  transcriptWrittenListeners.add(listener);
  return () => transcriptWrittenListeners.delete(listener);
}

export function subscribeTranscriptPurged(listener: TranscriptPurgedListener): () => void {
  transcriptPurgedListeners.add(listener);
  return () => transcriptPurgedListeners.delete(listener);
}

function notifyTranscriptWritten(directory: string, interactionId: string, transcript: CallTranscript): void {
  for (const listener of transcriptWrittenListeners) {
    try { listener(directory, interactionId, transcript); } catch { /* indexing must not fail durable transcript writes */ }
  }
}

function notifyTranscriptPurged(directory: string, interactionId: string): void {
  for (const listener of transcriptPurgedListeners) {
    try { listener(directory, interactionId); } catch { /* indexing must not fail retention cleanup */ }
  }
}

/** Owns per-call transcript sidecars and paths for telefony's finalized WAV files. */
export class CallArtifactStore {
  constructor(private readonly directory: string) {}

  writeTranscript(interactionId: string, transcript: CallTranscript): void {
    this.validateId(interactionId);
    mkdirSync(this.directory, { recursive: true });
    const sidecar = this.readSidecar(interactionId);
    this.writeSidecar(interactionId, { ...sidecar, ...transcript });
    notifyTranscriptWritten(this.directory, interactionId, transcript);
  }

  writeSummary(interactionId: string, summary: string): void {
    this.validateId(interactionId);
    mkdirSync(this.directory, { recursive: true });
    this.writeSidecar(interactionId, { ...this.readSidecar(interactionId), summary });
  }

  get(interactionId: string): CallArtifacts {
    this.validateId(interactionId);
    const sidecar = this.readSidecar(interactionId);
    return {
      transcript: this.readTranscript(sidecar),
      summary: typeof sidecar.summary === 'string' ? sidecar.summary : null,
      audioAvailable: this.hasAudio(interactionId),
    };
  }

  audioPath(interactionId: string): string {
    this.validateId(interactionId);
    return path.join(this.directory, `${interactionId}.wav`);
  }

  sweep(retention: CallArtifactRetention, now: Date): CallArtifactSweepResult {
    const removed: CallArtifactSweepResult = { recordingsRemoved: 0, transcriptsRemoved: 0 };
    if (!existsSync(this.directory)) return removed;
    for (const name of readdirSync(this.directory)) {
      const match = ARTIFACT.exec(name);
      const temporarySidecar = TEMP_SIDECAR.test(name);
      if (!match && !temporarySidecar) continue;
      const transcript = temporarySidecar || match?.[2] === 'json';
      const days = transcript ? retention.transcripts : retention.recordings;
      if (!temporarySidecar && (!Number.isFinite(days) || days <= 0)) continue;
      const maxAgeMs = temporarySidecar
        ? Math.min(Number.isFinite(days) && days > 0 ? days * DAY_MS : Number.POSITIVE_INFINITY, MAX_TEMP_SIDECAR_AGE_MS)
        : days * DAY_MS;
      try {
        if (statSync(path.join(this.directory, name)).mtimeMs >= now.getTime() - maxAgeMs) continue;
        unlinkSync(path.join(this.directory, name));
        if (temporarySidecar) removed.transcriptsRemoved++;
        else if (transcript && match) {
          removed.transcriptsRemoved++;
          notifyTranscriptPurged(this.directory, match[1]);
        }
        else removed.recordingsRemoved++;
      } catch { /* a file changed or disappeared during cleanup */ }
    }
    return removed;
  }

  private readTranscript(sidecar: Record<string, unknown>): CallTranscript | null {
    if (!isCallTranscript(sidecar)) return null;
    const { summary: _summary, ...transcript } = sidecar as CallTranscript & { summary?: unknown };
    return transcript;
  }

  private readSidecar(interactionId: string): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(readFileSync(this.transcriptPath(interactionId), 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch { return {}; }
  }

  private writeSidecar(interactionId: string, sidecar: Record<string, unknown>): void {
    const target = this.transcriptPath(interactionId);
    const temporary = path.join(this.directory, `.${interactionId}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(sidecar, null, 2), { encoding: 'utf8', flag: 'wx' });
      renameSync(temporary, target);
    } catch (err) {
      try { unlinkSync(temporary); } catch { /* no temporary file remains */ }
      throw err;
    }
  }

  private hasAudio(interactionId: string): boolean {
    try { return lstatSync(this.audioPath(interactionId)).isFile(); } catch { return false; }
  }

  private transcriptPath(interactionId: string): string {
    this.validateId(interactionId);
    return path.join(this.directory, `${interactionId}.json`);
  }

  private validateId(interactionId: string): void {
    if (!SAFE_ID.test(interactionId)) throw new Error('invalid call recording id');
  }
}

function isCallTranscript(value: unknown): value is CallTranscript {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CallTranscript>;
  return typeof item.date === 'string' && typeof item.contact === 'string' && typeof item.role === 'string'
    && (item.direction === 'inbound' || item.direction === 'outbound')
    && typeof item.durationS === 'number' && Array.isArray(item.handledBy) && item.handledBy.every((x) => typeof x === 'string')
    && Array.isArray(item.utterances) && item.utterances.every((utterance) => !!utterance
      && (utterance.speaker === 'local' || utterance.speaker === 'remote')
      && typeof utterance.text === 'string' && typeof utterance.startMs === 'number');
}
