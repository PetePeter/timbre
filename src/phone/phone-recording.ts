import { randomUUID } from 'node:crypto';
import type { AddressBookContact } from '../contacts/contact.js';
import type { RecordEvent, RecordEventKind, RecordEventType } from '../records/event-types.js';

export type RecordEventWriter = (event: RecordEvent) => void;

/** Keeps record creation and persistence failures out of the phone flow. */
export class PhoneRecording {
  constructor(
    private readonly write: RecordEventWriter | undefined,
    private readonly now: () => Date,
    private readonly log: (message: string) => void,
    private readonly lookupAddressBook?: (number: string) => AddressBookContact[],
  ) {}

  interactionId(): string { return randomUUID(); }

  record(interactionId: string, kind: RecordEventKind, type: RecordEventType, details: Record<string, unknown>, occurredAt?: string): void {
    if (!this.write) return;
    const parsed = occurredAt === undefined ? Number.NaN : Date.parse(occurredAt);
    const timestamp = Number.isFinite(parsed) ? new Date(parsed).toISOString() : this.now().toISOString();
    try {
      this.write({ eventId: randomUUID(), interactionId, kind, type, occurredAt: timestamp, details });
    } catch (err) {
      try { this.log(`phone record write failed: ${(err as Error).message}`); } catch { /* logging must not affect the call flow */ }
    }
  }

  policy(interactionId: string, action: string, allowed: boolean, details: Record<string, unknown> = {}): void {
    const kind: RecordEventKind = action.startsWith('sms.') ? 'sms' : 'call';
    this.record(interactionId, kind, 'policy.evaluated', { action, allowed, ...details });
  }

  recordAddressBookMatches(interactionId: string, kind: 'call' | 'sms', number: string): void {
    try {
      for (const contact of this.lookupAddressBook?.(number) ?? []) {
        // The name stays event data and is never inserted into an agent prompt.
        this.record(interactionId, kind, 'contact.matched', {
          contactId: contact.id, name: contact.name, number, direction: 'inbound',
        });
      }
    } catch (err) {
      try { this.log(`address book lookup failed: ${(err as Error).message}`); } catch { /* lookup failures must not affect phone flow */ }
    }
  }
}
