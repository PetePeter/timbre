/** Address book persistence. Line-policy contacts migrate onto this model in P-1102. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SUMMARY_NOTIFICATION_PREFERENCES, type AddressBookContact, type AddressBookContactInput } from './contact.js';
import { ContactPinStore } from './contact-pin-store.js';
import { normalizeAddressBookNumber } from './normalize-number.js';
import { contactPinValidationError } from './contact-validation.js';

export class ContactsStore {
  private static readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly file: string;
  private readonly pinStore: ContactPinStore;

  constructor(dataDir: string, phoneId: string, private readonly countryCode: string, private readonly log: (message: string) => void = () => {}) {
    if (!/^[\w-]+$/.test(phoneId)) throw new Error('Invalid phone ID.');
    const phoneDirectory = path.join(dataDir, 'phones', phoneId);
    this.file = path.join(phoneDirectory, 'contacts.json');
    this.pinStore = new ContactPinStore(phoneDirectory);
  }

  list(): AddressBookContact[] { return this.load().map((contact) => this.withPinStatus(contact)); }

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
        imported.push(this.withPinStatus(existing));
        continue;
      }
      const contact = { id: entry.id, ...input };
      this.validateDefaultTransfer(current, contact);
      current.push(contact);
      imported.push(this.withPinStatus(contact));
      changed = true;
    }
    if (changed) this.persist(current);
    return imported;
  }

  findByNumber(raw: string): AddressBookContact[] {
    let number: string;
    try { number = normalizeAddressBookNumber(raw, this.countryCode); } catch { return []; }
    return this.load().filter((contact) => contact.numbers.includes(number)).map((contact) => this.withPinStatus(contact));
  }

  add(input: AddressBookContactInput): Promise<AddressBookContact> {
    return this.mutate(() => {
      this.validatePinInput(input);
      const prepared = this.prepare(input);
      const current = this.load();
      const contact: AddressBookContact = { id: randomUUID(), ...prepared, summaryNotifications: prepared.summaryNotifications ?? [] };
      this.validateDefaultTransfer(current, contact);
      this.persist([...current, contact]);
      this.applyPinInput(contact, input);
      return this.withPinStatus(contact);
    });
  }

  update(id: string, input: AddressBookContactInput): Promise<AddressBookContact | null> {
    return this.mutate(() => {
      this.validatePinInput(input);
      const current = this.load();
      const index = current.findIndex((contact) => contact.id === id);
      if (index < 0) return null;
      const prepared = this.prepare(input);
      const updated: AddressBookContact = {
        id,
        ...prepared,
        ...(input.summaryNotifications === undefined && current[index]!.summaryNotifications !== undefined
          ? { summaryNotifications: current[index]!.summaryNotifications }
          : {}),
      };
      this.validateDefaultTransfer(current, updated, id);
      current[index] = updated;
      this.persist(current);
      this.applyPinInput(updated, input);
      return this.withPinStatus(updated);
    });
  }

  delete(id: string): Promise<boolean> {
    return this.mutate(() => {
      const current = this.load();
      const next = current.filter((contact) => contact.id !== id);
      if (next.length === current.length) return false;
      this.persist(next);
      this.pinStore.delete(id);
      return true;
    });
  }

  hasPin(contactId: string): boolean { return this.pinStore.hasPin(contactId); }

  setPin(contactId: string, pin: string): void {
    const contact = this.load().find((entry) => entry.id === contactId);
    if (!contact || !this.pinEligible(contact)) throw new Error('PINs can only be set for a user or trusted contact.');
    this.pinStore.setPin(contactId, pin);
  }

  verifyPin(contactId: string, pin: string): boolean {
    const contact = this.load().find((entry) => entry.id === contactId);
    return !!contact && this.pinEligible(contact) && this.pinStore.verifyPin(contactId, pin);
  }

  markPinNeedsReentry(contactId: string): void {
    const contact = this.load().find((entry) => entry.id === contactId);
    if (contact && this.pinEligible(contact)) this.pinStore.clearPin(contactId, true);
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
    if ((input.transferTarget !== undefined && typeof input.transferTarget !== 'boolean')
      || (input.defaultTransfer !== undefined && typeof input.defaultTransfer !== 'boolean')) {
      throw new Error('Contact transfer settings are invalid.');
    }
    const transferTarget = input.transferTarget ?? false;
    const defaultTransfer = input.defaultTransfer ?? false;
    if (defaultTransfer && !transferTarget) throw new Error('A default transfer contact must be a transfer target.');
    if (input.summaryNotifications !== undefined
      && (!Array.isArray(input.summaryNotifications)
        || input.summaryNotifications.some((value) => !SUMMARY_NOTIFICATION_PREFERENCES.includes(value)))) {
      throw new Error('Summary notification preferences are invalid.');
    }
    if (input.summaryNotifications?.length && input.isUser !== true) {
      throw new Error('Summary notifications can only be set for user contacts.');
    }
    return {
      name: input.name.trim(),
      numbers: [...new Set(input.numbers.map((number) => normalizeAddressBookNumber(number, this.countryCode)))],
      group: input.group.trim(),
      trusted: input.trusted,
      isUser: input.isUser,
      transferTarget,
      defaultTransfer,
      ...(input.summaryNotifications === undefined
        ? {}
        : { summaryNotifications: [...new Set(input.summaryNotifications)] }),
    };
  }

  private validatePinInput(input: AddressBookContactInput): void {
    const error = contactPinValidationError(input?.pin);
    if (error) throw new Error(error);
    if (input?.pin === undefined || input.pin === '') return;
    if (input.isUser !== true && input.trusted !== true) throw new Error('PINs can only be set for a user or trusted contact.');
  }

  private applyPinInput(contact: AddressBookContact, input: AddressBookContactInput): void {
    if (!this.pinEligible(contact)) {
      this.pinStore.delete(contact.id);
      return;
    }
    if (typeof input.pin === 'string' && input.pin.length > 0) this.pinStore.setPin(contact.id, input.pin);
    else if (input.clearPin === true || input.pin === '') this.pinStore.clearPin(contact.id);
  }

  private pinEligible(contact: AddressBookContact): boolean { return contact.isUser || contact.trusted; }

  private withPinStatus(contact: AddressBookContact): AddressBookContact {
    return {
      ...structuredClone(contact),
      pinSet: this.pinStore.hasPin(contact.id),
      pinNeedsReentry: this.pinStore.needsReentry(contact.id),
    };
  }

  private load(): AddressBookContact[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('expected a contact list');
      const contacts = parsed.map((value) => this.parseContact(value));
      this.validateDefaultTransferList(contacts);
      return contacts;
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
    if (contact.summaryNotifications !== undefined
      && (!Array.isArray(contact.summaryNotifications)
        || contact.summaryNotifications.some((value) => !SUMMARY_NOTIFICATION_PREFERENCES.includes(value)))) {
      throw new Error('contact summary notification preferences are invalid');
    }
    if ((contact.transferTarget !== undefined && typeof contact.transferTarget !== 'boolean')
      || (contact.defaultTransfer !== undefined && typeof contact.defaultTransfer !== 'boolean')) {
      throw new Error('contact transfer settings are invalid');
    }
    const transferTarget = contact.transferTarget ?? false;
    const defaultTransfer = contact.defaultTransfer ?? false;
    if (defaultTransfer && !transferTarget) throw new Error('default transfer contact is not a transfer target');
    return {
      id: contact.id, name: contact.name, numbers, group: contact.group, trusted: contact.trusted, isUser: contact.isUser,
      transferTarget, defaultTransfer,
      ...(contact.summaryNotifications === undefined
        ? {}
        : { summaryNotifications: [...new Set(contact.summaryNotifications)] }),
    };
  }

  private validateDefaultTransfer(current: AddressBookContact[], contact: AddressBookContact, excludingId?: string): void {
    if (!contact.defaultTransfer) return;
    if (!contact.transferTarget) throw new Error('A default transfer contact must be a transfer target.');
    if (current.some((entry) => entry.id !== excludingId && entry.defaultTransfer)) {
      throw new Error('Only one default transfer contact is allowed per phone.');
    }
  }

  private validateDefaultTransferList(contacts: AddressBookContact[]): void {
    if (contacts.filter((contact) => contact.defaultTransfer).length > 1) {
      throw new Error('Only one default transfer contact is allowed per phone.');
    }
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
