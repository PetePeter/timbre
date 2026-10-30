import { ContactsStore } from '../contacts/contacts-store.js';
import type { AddressBookContactInput } from '../contacts/contact.js';
import type { PhoneEntry } from '../config/timbre-config.js';
import type { Hub } from '../hub.js';
import type { CallAgentRequest } from '../phone/phone-bridge.js';
import { findContact } from '../phone/phone-config.js';
import type { RecordQueryOptions } from '../records/event-types.js';
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
  const contact = configuredContact ? { ...configuredContact, pattern: recipient } : {
    label: 'Unlisted recipient', pattern: recipient, role: 'trusted' as const,
    callIn: false, callOut: false, smsIn: false, smsOut: false, conf: false, pin: '', messages: false,
  };
  if (autoReply) {
    if (!line.sendSmsFromAction) return { sent: false, reason: 'internal SMS action unavailable' };
    return line.sendSmsFromAction(contact, text, interactionId, clientName, autoReply);
  }
  return line.sendSms(contact, text, interactionId, clientName);
}

export class InvalidCallRequestError extends Error {
  constructor() { super('Call request must include a destination and task.'); }
}

export function parseCallAgentRequest(value: unknown): CallAgentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidCallRequestError();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['to', 'task', 'maxWaitMin'].includes(key))) throw new InvalidCallRequestError();
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  const task = typeof input.task === 'string' ? input.task.trim() : '';
  const maxWaitMin = input.maxWaitMin;
  if (!to || to.length > 120 || !task || task.length > 4000
    || (maxWaitMin !== undefined && (typeof maxWaitMin !== 'number' || !Number.isFinite(maxWaitMin) || maxWaitMin <= 0 || maxWaitMin > 60))) {
    throw new InvalidCallRequestError();
  }
  return { to, task, ...(maxWaitMin === undefined ? {} : { maxWaitMin }) };
}

/** Shared by app-token and owner-authenticated routes; both must reach the same phone-line policy path. */
export function createCallAction(context: PhoneActionContext, phone: PhoneEntry, input: unknown, clientName: string) {
  const request = parseCallAgentRequest(input);
  const line = context.hub.line(phone.id);
  if (!line) throw new Error('Phone line unavailable.');
  return line.startOwnerCallAgent(request, clientName);
}

export function listRecords(context: PhoneActionContext, phoneId: string, options: RecordQueryOptions) {
  return context.hub.listRecords(phoneId, options);
}

export function getRecord(context: PhoneActionContext, phoneId: string, interactionId: string) {
  return context.hub.getRecord(phoneId, interactionId);
}

export function searchRecords(context: PhoneActionContext, phoneId: string, query: string) {
  return context.searchIndex.search(phoneId, query);
}

export function listContacts(context: PhoneActionContext, phone: PhoneEntry) {
  return contacts(context, phone).list();
}

export function findContacts(context: PhoneActionContext, phone: PhoneEntry, number: string) {
  return contacts(context, phone).findByNumber(number);
}

export function addContact(context: PhoneActionContext, phone: PhoneEntry, input: AddressBookContactInput) {
  return contacts(context, phone).add(input);
}

export function updateContact(context: PhoneActionContext, phone: PhoneEntry, id: string, input: AddressBookContactInput) {
  return contacts(context, phone).update(id, input);
}

export function deleteContact(context: PhoneActionContext, phone: PhoneEntry, id: string) {
  return contacts(context, phone).delete(id);
}

function contacts(context: PhoneActionContext, phone: PhoneEntry): ContactsStore {
  return new ContactsStore(context.dataDir, phone.id, phone.line.countryCode, context.log);
}
