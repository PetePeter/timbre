import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ARTIFACT = /^([A-Za-z0-9_-]{1,128})\.(json|wav|wav\.part)$/;

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

/** Owns per-call transcript sidecars and paths for telefony's finalized WAV files. */
export class CallArtifactStore {
  constructor(private readonly directory: string) {}

  writeTranscript(interactionId: string, transcript: CallTranscript): void {
    this.validateId(interactionId);
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.transcriptPath(interactionId), JSON.stringify(transcript, null, 2), 'utf8');
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

  sweep(retentionDays: number, now: Date): number {
    if (retentionDays <= 0 || !existsSync(this.directory)) return 0;
    const cutoff = now.getTime() - retentionDays * 86_400_000;
    const byId = new Map<string, string[]>();
    for (const name of readdirSync(this.directory)) {
      const match = ARTIFACT.exec(name);
      if (!match) continue;
      const files = byId.get(match[1]) ?? [];
      files.push(path.join(this.directory, name));
      byId.set(match[1], files);
    }
    let removed = 0;
    for (const files of byId.values()) {
      try {
        if (Math.max(...files.map((file) => statSync(file).mtimeMs)) >= cutoff) continue;
        for (const file of files) { unlinkSync(file); removed++; }
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
