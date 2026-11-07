import { ContactsStore } from '../contacts/contacts-store.js';
import type { PhoneEntry } from '../config/timbre-config.js';
import type { Hub } from '../hub.js';
import type { CallAgentRequest } from '../phone/phone-bridge.js';
import { findContact } from '../phone/phone-config.js';
import type { RecordKind, RecordQueryOptions } from '../records/event-types.js';
import type { RecordSearchIndex } from '../records/record-search-index.js';
import type { SmsAutoReplyAuthorization } from '../phone/sms-auto-reply.js';

export interface PhoneActionContext {
  hub: Hub;
  dataDir: string;
  log: (message: string) => void;
  searchIndex: RecordSearchIndex;
}

export async function sendSmsAction(
  context: Pick<PhoneActionContext, 'hub'>,
  phone: PhoneEntry,
  to: string,
  text: string,
  clientName?: string,
  autoReply?: SmsAutoReplyAuthorization,
  interactionId?: string,
) {
  const line = context.hub.line(phone.id);
  if (!line) return { sent: false, reason: 'phone line unavailable' };
  const recipient = autoReply?.sourceNumber ?? to;
  if (!recipient.trim()) return { sent: false, reason: 'SMS destination is required' };
  // Bridge policy remains authoritative. This fallback lets it record a normal
  // denial for unlisted or malformed targets without ever reaching telefony.
  const configuredContact = findContact(recipient, phone.line);
  const namedContact = configuredContact ? undefined : phone.line.contacts.find(
    (entry) => entry.label.trim().toLocaleLowerCase() === recipient.trim().toLocaleLowerCase(),
  );
  const contact = namedContact ?? (configuredContact ? { ...configuredContact, pattern: recipient } : {
    label: 'Unlisted recipient', pattern: recipient, role: 'trusted' as const,
    callIn: false, callOut: false, smsIn: false, smsOut: false, conf: false, pin: '', messages: false,
  });
  if (autoReply) {
    if (!line.sendSmsFromAction) return { sent: false, reason: 'internal SMS action unavailable' };
    return line.sendSmsFromAction(contact, text, interactionId, clientName, autoReply);
  }
  return line.sendSms(contact, text, interactionId, clientName);
}

export class InvalidCallRequestError extends Error {
  constructor(message = 'Call request must include a destination and task.') { super(message); }
}

export function parseCallAgentRequest(value: unknown): CallAgentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidCallRequestError();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['to', 'task', 'maxWaitMin', 'mode'].includes(key))) throw new InvalidCallRequestError();
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  const task = typeof input.task === 'string' ? input.task.trim() : '';
  const maxWaitMin = input.maxWaitMin;
  const mode = input.mode ?? 'agent';
  if (mode !== 'agent' && mode !== 'drive') throw new InvalidCallRequestError('mode must be "agent" or "drive".');
  if (!to || to.length > 120 || (mode === 'agent' && !task) || task.length > 4000
    || (maxWaitMin !== undefined && (typeof maxWaitMin !== 'number' || !Number.isFinite(maxWaitMin) || maxWaitMin <= 0 || maxWaitMin > 60))) {
    throw new InvalidCallRequestError();
  }
  return { to, task, ...(maxWaitMin === undefined ? {} : { maxWaitMin }), ...(mode === 'drive' ? { mode } : {}) };
}

/** Shared by app-token and owner-authenticated routes; both must reach the same phone-line policy path. */
export function createCallAction(context: PhoneActionContext, phone: PhoneEntry, input: unknown, clientName: string, appId?: string) {
  const request = parseCallAgentRequest(input);
  const line = context.hub.line(phone.id);
  if (!line) throw new Error('Phone line unavailable.');
  return line.startOwnerCallAgent(request, clientName, appId);
}

export function listRecords(context: PhoneActionContext, phoneId: string, kind: RecordKind, options: Pick<RecordQueryOptions, 'limit' | 'cursor'>) {
  return context.hub.listRecords(phoneId, { ...options, filter: kind === 'sms' ? 'sms' : 'calls' });
}

export function getRecord(context: PhoneActionContext, phoneId: string, kind: RecordKind, interactionId: string) {
  const record = context.hub.getRecord(phoneId, interactionId);
  return record?.kind === kind ? record : null;
}

export function searchRecords(context: PhoneActionContext, phoneId: string, kind: RecordKind, query: string) {
  const result = context.searchIndex.search(phoneId, query);
  return { ...result, items: result.items.filter((item) => item.kind === kind) };
}

export function listContacts(context: PhoneActionContext, phone: PhoneEntry) {
  return contacts(context, phone).list();
}

export function findContacts(context: PhoneActionContext, phone: PhoneEntry, number: string) {
  return contacts(context, phone).findByNumber(number);
}

function contacts(context: PhoneActionContext, phone: PhoneEntry): ContactsStore {
  return new ContactsStore(context.dataDir, phone.id, phone.line.countryCode, context.log);
}
