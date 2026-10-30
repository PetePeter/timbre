import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface PinRecord {
  salt?: string;
  hash?: string;
  needsReentry?: boolean;
}

type PinRecords = Record<string, PinRecord>;

/** Stores credentials and migration status beside one phone's address book. */
export class ContactPinStore {
  private readonly file: string;

  constructor(phoneDirectory: string) {
    this.file = path.join(phoneDirectory, 'contact-pins.json');
  }

  hasPin(contactId: string): boolean {
    const record = this.load()[contactId];
    return !!record?.salt && !!record.hash;
  }

  needsReentry(contactId: string): boolean {
    return this.load()[contactId]?.needsReentry === true;
  }

  setPin(contactId: string, pin: string): void {
    if (!/^\d{6,}$/.test(pin)) throw new Error('PIN must contain at least six digits.');
    const records = this.load();
    const salt = randomBytes(16);
    records[contactId] = {
      salt: salt.toString('hex'),
      hash: scryptSync(pin, salt, 64).toString('hex'),
    };
    this.persist(records);
  }

  verifyPin(contactId: string, pin: string): boolean {
    if (!/^\d{6,}$/.test(pin)) return false;
    const record = this.load()[contactId];
    if (!record?.salt || !record.hash || !/^[a-f\d]{32}$/.test(record.salt) || !/^[a-f\d]{128}$/.test(record.hash)) return false;
    const expected = Buffer.from(record.hash, 'hex');
    const actual = scryptSync(pin, Buffer.from(record.salt, 'hex'), expected.length);
    return timingSafeEqual(actual, expected);
  }

  clearPin(contactId: string, needsReentry = false): void {
    const records = this.load();
    if (!needsReentry) delete records[contactId];
    else records[contactId] = { needsReentry: true };
    this.persist(records);
  }

  delete(contactId: string): void {
    const records = this.load();
    if (!(contactId in records)) return;
    delete records[contactId];
    this.persist(records);
  }

  private load(): PinRecords {
    if (!existsSync(this.file)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a PIN record map');
      const records: PinRecords = {};
      for (const [contactId, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a contact PIN record');
        const record = value as PinRecord;
        const salt = typeof record.salt === 'string' ? record.salt : undefined;
        const hash = typeof record.hash === 'string' ? record.hash : undefined;
        const needsReentry = record.needsReentry === true;
        if ((salt && !/^[a-f\d]{32}$/.test(salt)) || (hash && !/^[a-f\d]{128}$/.test(hash))) throw new Error('invalid contact PIN record');
        if (salt && hash || needsReentry) records[contactId] = { ...(salt && hash ? { salt, hash } : {}), ...(needsReentry ? { needsReentry: true } : {}) };
      }
      return records;
    } catch (err) {
      throw new Error(`Contact PIN file ${this.file} is invalid: ${(err as Error).message}`, { cause: err });
    }
  }

  private persist(records: PinRecords): void {
    const folder = path.dirname(this.file);
    mkdirSync(folder, { recursive: true });
    const temp = `${this.file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(records, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temp, this.file);
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true });
    }
  }
}
