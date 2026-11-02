import { describe, expect, it } from 'vitest';
import type { AddressBookContact } from '../src/contacts/contact.js';
import { contactGroups, filterContacts, type ContactFilter } from './contact-filter.js';

const contacts: AddressBookContact[] = [
  { id: 'jordan', name: 'Jordan Lee', numbers: ['+61412345678'], group: 'Family', trusted: true, isUser: true },
  { id: 'alex', name: 'Alex Morgan', numbers: ['+61401234567'], group: 'Work', trusted: false, isUser: false },
  { id: 'riley', name: 'Riley Chen', numbers: ['0412345678'], group: '', trusted: false, isUser: false },
];

describe('contact filtering', () => {
  it('returns distinct non-empty groups in alphabetical order', () => {
    expect(contactGroups(contacts)).toEqual(['Family', 'Work']);
  });

  it('filters all, trusted, user, and group contacts', () => {
    const filter = (kind: ContactFilter) => filterContacts(contacts, kind).map(({ id }) => id);
    expect(filter({ kind: 'all' })).toEqual(['jordan', 'alex', 'riley']);
    expect(filter({ kind: 'trusted' })).toEqual(['jordan']);
    expect(filter({ kind: 'you' })).toEqual(['jordan']);
    expect(filter({ kind: 'group', group: 'Family' })).toEqual(['jordan']);
  });

  it('searches case-insensitive names, groups, status flags, and equivalent phone formats', () => {
    expect(filterContacts(contacts, { kind: 'all' }, 'ALEX')).toEqual([contacts[1]]);
    expect(filterContacts(contacts, { kind: 'all' }, 'family')).toEqual([contacts[0]]);
    expect(filterContacts(contacts, { kind: 'all' }, 'trusted')).toEqual([contacts[0]]);
    expect(filterContacts(contacts, { kind: 'all' }, 'you')).toEqual([contacts[0]]);
    expect(filterContacts(contacts, { kind: 'all' }, '0412 345 678')).toEqual([contacts[0], contacts[2]]);
  });

  it('combines the selected filter with the search query', () => {
    expect(filterContacts(contacts, { kind: 'group', group: 'Family' }, 'Jordan')).toEqual([contacts[0]]);
    expect(filterContacts(contacts, { kind: 'trusted' }, 'Alex')).toEqual([]);
  });
});
