import type { ChatSendResult } from '../session/chat/chat-bridge.js';
import type { AddressBookContact, SummaryNotificationPreference } from '../contacts/contact.js';
import type { CallOutcome } from '../records/event-types.js';
import type { PhoneContact } from '../phone/phone-config.js';

export type CallSummaryTrigger = 'call_ended' | 'call_outcome';
export type CallSummaryNotificationEvent = 'notify.sent' | 'notify.failed';

export interface CallSummaryRecipient {
  contactId: string;
  preferences: readonly SummaryNotificationPreference[] | undefined;
  contact: PhoneContact;
}

export function resolveCallSummaryRecipients(
  lineContacts: readonly PhoneContact[],
  lookupAddressBook: (number: string) => AddressBookContact[],
): CallSummaryRecipient[] {
  const recipients = new Map<string, CallSummaryRecipient>();
  for (const lineContact of lineContacts) {
    if (!lineContact.smsOut || lineContact.pattern.includes('*')) continue;
    for (const contact of lookupAddressBook(lineContact.pattern)) {
      if (!contact.isUser || (lineContact.contactId && lineContact.contactId !== contact.id) || recipients.has(contact.id)) continue;
      recipients.set(contact.id, {
        contactId: contact.id,
        preferences: contact.summaryNotifications,
        contact: lineContact,
      });
    }
  }
  return [...recipients.values()];
}

export function shouldNotifyCallSummary(input: {
  preferences: readonly SummaryNotificationPreference[] | undefined;
  trigger: CallSummaryTrigger;
  answered: boolean;
  outcome?: CallOutcome;
}): boolean {
  const { preferences, trigger, answered, outcome } = input;
  if (!preferences?.length) return false;
  if (preferences.includes('all')) return trigger === 'call_ended';
  if (trigger === 'call_ended') return preferences.includes('missed') && !answered;
  if (preferences.includes('missed') && outcome === 'early_hangup') return true;
  if (preferences.includes('handed_over') && outcome === 'handed_over') return true;
  return preferences.includes('left_message') && outcome === 'left_message';
}

const GSM7_BASIC = new Set(Array.from(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
));
const GSM7_EXTENSION = new Set(Array.from('^{}\\[~]|€\f'));

export function splitSummarySms(text: string, maxParts = 3, smsSuffix = ''): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || maxParts < 1) return [];
  const chars = Array.from(normalized);
  const suffixChars = Array.from(smsSuffix);
  const isGsm7 = [...chars, ...suffixChars].every((char) => GSM7_BASIC.has(char) || GSM7_EXTENSION.has(char));
  const unitSize = (char: string) => isGsm7
    ? (GSM7_EXTENSION.has(char) ? 2 : 1)
    : char.length;
  const suffixUnits = suffixChars.reduce((total, char) => total + unitSize(char), 0);
  const units = chars.reduce((total, char) => total + unitSize(char), suffixUnits);
  const singlePartLimit = isGsm7 ? 160 : 70;
  const partLimit = isGsm7 ? 153 : 67;
  if (units <= singlePartLimit) return [normalized];
  const contentLimit = partLimit - suffixUnits;
  if (contentLimit < 1) return [];

  const parts: string[] = [];
  let cursor = 0;
  while (cursor < chars.length && parts.length < maxParts) {
    let end = cursor;
    let segmentUnits = 0;
    let lastSpace = -1;
    while (end < chars.length && segmentUnits + unitSize(chars[end]!) <= contentLimit) {
      segmentUnits += unitSize(chars[end]!);
      if (chars[end] === ' ') lastSpace = end;
      end++;
    }
    if (end < chars.length && lastSpace >= cursor + Math.floor((end - cursor) * 0.55)) end = lastSpace;
    if (end === cursor) break;
    const part = chars.slice(cursor, end).join('').trim();
    if (part) parts.push(part);
    cursor = end;
    while (chars[cursor] === ' ') cursor++;
  }
  if (cursor < chars.length && parts.length) {
    const marker = isGsm7 ? '.' : '…';
    const last = Array.from(parts[parts.length - 1]!);
    let lastUnits = last.reduce((total, char) => total + unitSize(char), 0);
    while (last.length && lastUnits + unitSize(marker) > contentLimit) {
      lastUnits -= unitSize(last.pop()!);
    }
    parts[parts.length - 1] = `${last.join('').trimEnd()}${marker}`;
  }
  return parts;
}

export interface CallSummaryNotifierDeps {
  sendSms: (contact: PhoneContact, text: string, interactionId: string) => Promise<ChatSendResult>;
  recordEvent: (interactionId: string, type: CallSummaryNotificationEvent, details: Record<string, unknown>) => void;
  smsSuffix?: () => string;
}

export interface CallSummaryNotification {
  interactionId: string;
  contactId: string;
  contact: PhoneContact;
  summary: string;
  outcome?: CallOutcome;
}

/** Sends call-only summaries. It is called by call lifecycle hooks and never subscribes to SMS events. */
export class CallSummaryNotifier {
  private readonly attempted = new Set<string>();

  constructor(private readonly deps: CallSummaryNotifierDeps) {}

  async notify(input: CallSummaryNotification): Promise<boolean> {
    const parts = splitSummarySms(input.summary, 3, this.deps.smsSuffix?.() ?? '');
    if (!parts.length) return false;
    const key = `${input.interactionId}\0${input.contactId}`;
    if (this.attempted.has(key)) return false;
    this.attempted.add(key);

    let partsSent = 0;
    let reason: string | undefined;
    for (const part of parts) {
      try {
        const result = await this.deps.sendSms(input.contact, part, input.interactionId);
        if (!result.sent) {
          reason = result.reason || 'SMS send denied.';
          break;
        }
        partsSent++;
      } catch (err) {
        reason = (err as Error).message || 'SMS send failed.';
        break;
      }
    }
    const type: CallSummaryNotificationEvent = reason ? 'notify.failed' : 'notify.sent';
    this.deps.recordEvent(input.interactionId, type, {
      contactId: input.contactId,
      outcome: input.outcome ?? 'unclassified',
      partsSent,
      partsTotal: parts.length,
      ...(reason ? { reason } : {}),
    });
    return !reason;
  }
}
