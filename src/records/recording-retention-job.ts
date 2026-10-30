import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { PhoneLineConfig } from '../phone/phone-config.js';
import type { RecordEvent } from './event-types.js';
import { CallArtifactStore } from './call-artifacts.js';
import { purgeTranscriptExports } from './transcript-exports.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PHONE_ID = /^[\w-]+$/;

export interface RetentionPhone {
  id: string;
  line: Pick<PhoneLineConfig, 'recordings' | 'transcripts'>;
}

export interface RecordingRetentionJobDeps {
  dataDir: string;
  getPhones: () => RetentionPhone[];
  recordEvent: (phoneId: string, event: RecordEvent) => void;
  now?: () => Date;
  log?: (message: string) => void;
}

/** Hub-owned immediate and daily cleanup across the currently configured phones. */
export class RecordingRetentionJob {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: RecordingRetentionJobDeps) {}

  start(): Promise<void> {
    if (this.timer) return this.running ?? Promise.resolve();
    this.timer = setInterval(() => { void this.sweep(); }, DAY_MS);
    this.timer.unref?.();
    return this.sweep();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  sweep(): Promise<void> {
    if (this.running) return this.running;
    const run = this.sweepPhones();
    const tracked = run.finally(() => { if (this.running === tracked) this.running = null; });
    this.running = tracked;
    return tracked;
  }

  private async sweepPhones(): Promise<void> {
    let phones: RetentionPhone[];
    try { phones = this.deps.getPhones(); }
    catch (error) { this.log(`recording retention config read failed: ${message(error)}`); return; }

    for (const phone of phones) {
      try {
        if (!PHONE_ID.test(phone.id)) throw new Error('invalid phone id');
        const now = this.deps.now?.() ?? new Date();
        const phoneDir = path.join(this.deps.dataDir, 'phones', phone.id);
        const counts = new CallArtifactStore(path.join(phoneDir, 'recordings')).sweep({
          recordings: phone.line.recordings.retentionDays,
          transcripts: phone.line.transcripts.retentionDays,
        }, now);
        const customTranscriptFolder = phone.line.transcripts.folder;
        counts.transcriptsRemoved += await purgeTranscriptExports(
          customTranscriptFolder || path.join(phoneDir, 'transcripts'),
          phone.line.transcripts.retentionDays,
          now,
          customTranscriptFolder ? phone.id : undefined,
        );
        if (!counts.recordingsRemoved && !counts.transcriptsRemoved) continue;
        const eventId = randomUUID();
        this.deps.recordEvent(phone.id, {
          eventId,
          interactionId: eventId,
          kind: 'system',
          type: 'retention.purged',
          occurredAt: now.toISOString(),
          details: { ...counts },
        });
      } catch (error) {
        this.log(`recording retention failed for phone ${phone.id}: ${message(error)}`);
      }
    }
  }

  private log(text: string): void {
    try { this.deps.log?.(text); } catch { /* cleanup must not depend on logging */ }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
