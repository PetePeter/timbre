import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { ContactsStore } from '../src/contacts/contacts-store.js';
import { ConfigStore } from '../src/config/timbre-config.js';
import { projectPhoneContacts } from '../src/phone/inbound-call-policy.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('legacy phone contact migration', () => {
  it('imports legacy identities once, keeps access rules, and rewrites old config without contacts', () => {
    const dir = path.join(tmpdir(), `timbre-migration-${Math.random().toString(36).slice(2)}`);
    dirs.push(dir);
    mkdirSync(path.join(dir, 'phones', 'phone-a'), { recursive: true });
    writeFileSync(path.join(dir, 'phones', 'phone-a', 'contacts.json'), JSON.stringify([
      { id: 'existing', name: 'Existing Maya', numbers: ['+61491570156'], group: 'Family', trusted: true, isUser: true },
    ]));
    const file = path.join(dir, 'config.yaml');
    writeFileSync(file, YAML.stringify({
      phones: [{ id: 'phone-a', name: 'Home', llmId: 'llm-a', mcpServers: [], line: {
        countryCode: '+61', contacts: [
          { label: 'Maya', pattern: '0491570156', role: 'owner', callIn: true, callOut: true, smsIn: true, smsOut: true, conf: true, pin: '246813', messages: true },
          { label: 'Spam', pattern: '+6129000*', role: 'blocked', callIn: false, callOut: false, smsIn: false, smsOut: false, conf: false, pin: '', messages: false },
        ],
      } }],
      llms: [{ id: 'llm-a', name: 'Local', kind: 'api', baseUrl: 'http://localhost/v1', model: 'test', apiKey: '' }],
      web: { port: 7790, lan: false, token: '' },
    }));

    const first = new ConfigStore(file).get();
    const line = first.phones[0].line as typeof first.phones[0]['line'] & { contactRules: Array<Record<string, unknown>> };
    const book = new ContactsStore(dir, 'phone-a', '+61').list();
    const persisted = YAML.parse(readFileSync(file, 'utf8')) as { phones: Array<{ line: Record<string, unknown> }> };

    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ id: 'existing', name: 'Existing Maya' });
    expect(line.contactRules).toContainEqual(expect.objectContaining({
      contactId: 'existing', role: 'owner', callIn: true, callOut: true, pin: '', messages: true,
    }));
    expect(line.screening.block).toContainEqual({ kind: 'number', value: '+6129000*' });
    expect(line.blocklist).not.toContain('^\\+6129000');
    expect(line.contactRules).not.toContainEqual(expect.objectContaining({ role: 'blocked' }));
    expect(projectPhoneContacts(line, book)).toContainEqual(expect.objectContaining({
      label: 'Existing Maya', pattern: '+61491570156', role: 'owner', pin: '', contactId: 'existing',
    }));
    const contacts = new ContactsStore(dir, 'phone-a', '+61');
    expect(contacts.verifyPin('existing', '246813')).toBe(true);
    expect(book[0]).toMatchObject({ pinSet: true, pinNeedsReentry: false });
    expect(persisted.phones[0].line).not.toHaveProperty('contacts');
    expect(persisted.phones[0].line).not.toHaveProperty('ownerPin');
    expect(readFileSync(file, 'utf8')).not.toContain('246813');
    expect(existsSync(path.join(dir, 'phones', 'phone-a', 'contacts.json'))).toBe(true);

    const second = new ConfigStore(file).get().phones[0].line as typeof line;
    expect(new ContactsStore(dir, 'phone-a', '+61').list()).toHaveLength(1);
    expect(second.contactRules).toEqual(line.contactRules);
  });

  it('keeps exact-number permissions scoped when the address-book contact has other numbers', () => {
    const dir = path.join(tmpdir(), `timbre-migration-${Math.random().toString(36).slice(2)}`);
    dirs.push(dir);
    mkdirSync(path.join(dir, 'phones', 'phone-a'), { recursive: true });
    writeFileSync(path.join(dir, 'phones', 'phone-a', 'contacts.json'), JSON.stringify([
      { id: 'existing', name: 'Address book contact', numbers: ['+61491570156', '+61400000001'], group: 'Family', trusted: true, isUser: false },
    ]));
    const file = path.join(dir, 'config.yaml');
    writeFileSync(file, YAML.stringify({
      phones: [{ id: 'phone-a', line: { countryCode: '+61', contacts: [
        { label: 'Legacy caller', pattern: '0491570156', role: 'trusted', callIn: false, callOut: true, smsIn: false, smsOut: false, conf: false, pin: '', messages: false },
      ] } }],
    }));

    const line = new ConfigStore(file).get().phones[0].line;
    const book = new ContactsStore(dir, 'phone-a', '+61').list();

    expect(line.contactRules).toContainEqual(expect.objectContaining({
      contactId: 'existing', pattern: '+61491570156', callIn: false, callOut: true,
    }));
    expect(projectPhoneContacts(line, book).map((contact) => contact.pattern)).toEqual(['+61491570156']);
  });

  it('migrates a legacy row without a role as trusted', () => {
    const dir = path.join(tmpdir(), `timbre-migration-${Math.random().toString(36).slice(2)}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'config.yaml');
    writeFileSync(file, YAML.stringify({
      phones: [{ id: 'phone-a', line: { countryCode: '+61', contacts: [
        { label: 'Legacy caller', pattern: '0491570156', callIn: true, callOut: false, smsIn: true, smsOut: false, conf: false, pin: '', messages: false },
      ] } }],
    }));

    const line = new ConfigStore(file).get().phones[0].line;
    const book = new ContactsStore(dir, 'phone-a', '+61').list();

    expect(line.contactRules).toContainEqual(expect.objectContaining({ role: 'trusted', callIn: true }));
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ name: 'Legacy caller', trusted: true });
  });

  it('clears prefix PINs, warns without digits, and marks eligible matching contacts for re-entry', () => {
    const dir = path.join(tmpdir(), `timbre-migration-${Math.random().toString(36).slice(2)}`);
    dirs.push(dir);
    const people = new ContactsStore(dir, 'phone-a', '+61');
    people.importLegacy([
      { id: 'maya', input: { name: 'Maya', numbers: ['+61491570156'], group: '', trusted: true, isUser: false } },
      { id: 'lee', input: { name: 'Lee', numbers: ['+61491570187'], group: '', trusted: true, isUser: false } },
      { id: 'other', input: { name: 'Other', numbers: ['+61290001234'], group: '', trusted: false, isUser: false } },
    ]);
    const file = path.join(dir, 'config.yaml');
    writeFileSync(file, YAML.stringify({ phones: [{ id: 'phone-a', line: { countryCode: '+61', contacts: [
      { label: 'Legacy mobile', pattern: '+6149*', role: 'trusted', callIn: true, callOut: false, smsIn: false, smsOut: false, conf: false, pin: '975310', messages: false },
    ] } }] }));
    const warnings: string[] = [];
    const line = new ConfigStore(file, (message) => warnings.push(message)).get().phones[0].line;
    const book = people.list();

    expect(book.find((contact) => contact.id === 'maya')).toMatchObject({ pinSet: false, pinNeedsReentry: true });
    expect(book.find((contact) => contact.id === 'lee')).toMatchObject({ pinSet: false, pinNeedsReentry: true });
    expect(book.find((contact) => contact.id === 'other')).toMatchObject({ pinSet: false, pinNeedsReentry: false });
    expect(people.verifyPin('maya', '975310')).toBe(false);
    expect(line.contactRules[0].pin).toBe('');
    expect(readFileSync(file, 'utf8')).not.toContain('975310');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).not.toMatch(/\d/);
  });
});
