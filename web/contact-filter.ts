import type { AddressBookContact } from '../src/contacts/contact.js';
import { matchContactsByNumber } from '../src/contacts/match-number.js';

export type ContactFilter =
  | { kind: 'all' }
  | { kind: 'trusted' }
  | { kind: 'you' }
  | { kind: 'group'; group: string };

export function contactGroups(contacts: AddressBookContact[]): string[] {
  const groups = new Map<string, string>();
  for (const contact of contacts) {
    const group = contact.group.trim();
    if (group && !groups.has(group.toLocaleLowerCase())) groups.set(group.toLocaleLowerCase(), group);
  }
  return [...groups.values()].sort((a, b) => a.localeCompare(b));
}

export function filterContacts(
  contacts: AddressBookContact[],
  filter: ContactFilter,
  search = '',
): AddressBookContact[] {
  const query = search.trim().toLocaleLowerCase();
  const digits = search.replace(/\D/g, '');
  const numberMatches = digits.length >= 9
    ? new Set(matchContactsByNumber(contacts, search, null))
    : new Set<AddressBookContact>();

  return contacts.filter((contact) => {
    if (filter.kind === 'trusted' && !contact.trusted) return false;
    if (filter.kind === 'you' && !contact.isUser) return false;
    if (filter.kind === 'group' && contact.group.trim().toLocaleLowerCase() !== filter.group.trim().toLocaleLowerCase()) return false;
    if (!query) return true;
    const fields = [contact.name, contact.group, ...contact.numbers].map((field) => field.toLocaleLowerCase());
    const textMatch = fields.some((field) => field.includes(query));
    const flagMatch = (query === 'trusted' && contact.trusted) || (query === 'you' && contact.isUser);
    const numberMatch = numberMatches.has(contact);
    return textMatch || flagMatch || numberMatch;
  });
}
