import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ARTIFACT = /^([A-Za-z0-9_-]{1,128})\.(json|wav|wav\.part)$/;

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
    writeFileSync(this.transcriptPath(interactionId), JSON.stringify(transcript, null, 2), 'utf8');
    notifyTranscriptWritten(this.directory, interactionId, transcript);
  }

  get(interactionId: string): CallArtifacts {
    this.validateId(interactionId);
    return {
      transcript: this.readTranscript(interactionId),
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
      if (!match) continue;
      const transcript = match[2] === 'json';
      const days = transcript ? retention.transcripts : retention.recordings;
      if (!Number.isFinite(days) || days <= 0) continue;
      try {
        if (statSync(path.join(this.directory, name)).mtimeMs >= now.getTime() - days * 86_400_000) continue;
        unlinkSync(path.join(this.directory, name));
        if (transcript) {
          removed.transcriptsRemoved++;
          notifyTranscriptPurged(this.directory, match[1]);
        }
        else removed.recordingsRemoved++;
      } catch { /* a file changed or disappeared during cleanup */ }
    }
    return removed;
  }

  private readTranscript(interactionId: string): CallTranscript | null {
    const file = this.transcriptPath(interactionId);
    try {
      const transcript: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return isCallTranscript(transcript) ? transcript : null;
    } catch { return null; }
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
