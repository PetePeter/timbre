import { ContactsStore } from '../contacts/contacts-store.js';
import type { AddressBookContactInput } from '../contacts/contact.js';
import type { PhoneEntry } from '../config/timbre-config.js';
import type { Hub } from '../hub.js';
import { findContact } from '../phone/phone-config.js';
import type { RecordQueryOptions } from '../records/event-types.js';
import type { RecordSearchIndex } from '../records/record-search-index.js';

export interface PhoneActionContext {
  hub: Hub;
  dataDir: string;
  log: (message: string) => void;
  searchIndex: RecordSearchIndex;
}

export async function sendSmsAction(
  context: PhoneActionContext,
  phone: PhoneEntry,
  to: string,
  text: string,
  clientName: string,
) {
  const line = context.hub.line(phone.id);
  if (!line) return { sent: false, reason: 'phone line unavailable' };
  // Bridge policy remains authoritative. This fallback lets it record a normal
  // denial for unlisted or malformed targets without ever reaching telefony.
  const configuredContact = findContact(to, phone.line);
  const contact = configuredContact ? { ...configuredContact, pattern: to } : {
    label: 'Unlisted recipient', pattern: to, role: 'trusted' as const,
    callIn: false, callOut: false, smsIn: false, smsOut: false, conf: false, pin: '', messages: false,
  };
  return line.sendSms(contact, text, undefined, clientName);
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
