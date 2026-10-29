/** Address book persistence. Line-policy contacts migrate onto this model in P-1102. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressBookContact, AddressBookContactInput } from './contact.js';
import { normalizeAddressBookNumber } from './normalize-number.js';

export class ContactsStore {
  private static readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly file: string;

  constructor(dataDir: string, phoneId: string, private readonly countryCode: string, private readonly log: (message: string) => void = () => {}) {
    if (!/^[\w-]+$/.test(phoneId)) throw new Error('Invalid phone ID.');
    this.file = path.join(dataDir, 'phones', phoneId, 'contacts.json');
  }

  list(): AddressBookContact[] { return this.load(); }

  /** Imports deterministic legacy identities without replacing contacts already in the book. */
  importLegacy(legacy: Array<{ id: string; input: AddressBookContactInput }>): AddressBookContact[] {
    const current = this.load();
    const imported: AddressBookContact[] = [];
    let changed = false;
    for (const entry of legacy) {
      const input = this.prepare(entry.input);
      const existing = current.find((contact) => contact.id === entry.id)
        ?? current.find((contact) => contact.numbers.some((number) => input.numbers.includes(number)));
      if (existing) {
        imported.push(structuredClone(existing));
        continue;
      }
      const contact = { id: entry.id, ...input };
      current.push(contact);
      imported.push(structuredClone(contact));
      changed = true;
    }
    if (changed) this.persist(current);
    return imported;
  }

  findByNumber(raw: string): AddressBookContact[] {
    let number: string;
    try { number = normalizeAddressBookNumber(raw, this.countryCode); } catch { return []; }
    return this.load().filter((contact) => contact.numbers.includes(number));
  }

  add(input: AddressBookContactInput): Promise<AddressBookContact> {
    return this.mutate(() => {
      const contact = { id: randomUUID(), ...this.prepare(input) };
      this.persist([...this.load(), contact]);
      return structuredClone(contact);
    });
  }

  update(id: string, input: AddressBookContactInput): Promise<AddressBookContact | null> {
    return this.mutate(() => {
      const current = this.load();
      const index = current.findIndex((contact) => contact.id === id);
      if (index < 0) return null;
      const updated = { id, ...this.prepare(input) };
      current[index] = updated;
      this.persist(current);
      return structuredClone(updated);
    });
  }

  delete(id: string): Promise<boolean> {
    return this.mutate(() => {
      const current = this.load();
      const next = current.filter((contact) => contact.id !== id);
      if (next.length === current.length) return false;
      this.persist(next);
      return true;
    });
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    const previous = ContactsStore.mutationQueues.get(this.file) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    ContactsStore.mutationQueues.set(this.file, queued);
    await previous;
    try {
      return operation();
    } finally {
      release();
      if (ContactsStore.mutationQueues.get(this.file) === queued) ContactsStore.mutationQueues.delete(this.file);
    }
  }

  private prepare(input: AddressBookContactInput): AddressBookContactInput {
    if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !input.name.trim()) {
      throw new Error('Contact name is required.');
    }
    if (!Array.isArray(input.numbers) || input.numbers.length === 0 || input.numbers.some((number) => typeof number !== 'string')) {
      throw new Error('At least one phone number is required.');
    }
    if (typeof input.group !== 'string' || typeof input.trusted !== 'boolean' || typeof input.isUser !== 'boolean') {
      throw new Error('Contact details are invalid.');
    }
    return {
      name: input.name.trim(),
      numbers: [...new Set(input.numbers.map((number) => normalizeAddressBookNumber(number, this.countryCode)))],
      group: input.group.trim(),
      trusted: input.trusted,
      isUser: input.isUser,
    };
  }

  private load(): AddressBookContact[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('expected a contact list');
      return parsed.map((value) => this.parseContact(value));
    } catch (err) {
      const message = `Contacts file ${this.file} is invalid: ${(err as Error).message}`;
      this.log(message);
      throw new Error(message, { cause: err });
    }
  }

  private parseContact(value: unknown): AddressBookContact {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a contact object');
    const contact = value as Partial<AddressBookContact>;
    if (typeof contact.id !== 'string' || !contact.id || typeof contact.name !== 'string' || !contact.name.trim()
      || !Array.isArray(contact.numbers) || !contact.numbers.length
      || typeof contact.group !== 'string' || typeof contact.trusted !== 'boolean' || typeof contact.isUser !== 'boolean') {
      throw new Error('contact fields are invalid');
    }
    const numbers = contact.numbers.map((number) => {
      if (typeof number !== 'string') throw new Error('contact number is invalid');
      const normalized = normalizeAddressBookNumber(number, this.countryCode);
      if (normalized !== number) throw new Error('saved contact number is not normalized');
      return number;
    });
    return { id: contact.id, name: contact.name, numbers, group: contact.group, trusted: contact.trusted, isUser: contact.isUser };
  }

  private persist(contacts: AddressBookContact[]): void {
    const folder = path.dirname(this.file);
    mkdirSync(folder, { recursive: true });
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(contacts, null, 2)}\n`, { flag: 'wx' });
      renameSync(temp, this.file);
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true });
    }
  }
}
