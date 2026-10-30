import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { normalizeAddressBookNumber } from '../contacts/normalize-number.js';
import { normalizeConfig, serializeConfigYaml, type TimbreConfig } from '../config/timbre-config.js';
import type { AddressBookContact } from '../contacts/contact.js';
import { BackupSizeLimitError, decodeBackup, encodeBackup, type RestoredBackup } from './archive.js';
import type { RestoreFileChange } from '../config/restore-transaction.js';

const PHONE_ID = /^[\w-]{1,100}$/;
const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export interface CreateBackupOptions {
  includeRecords?: boolean;
  includeSecrets?: boolean;
  passphrase?: string;
  maxArchiveBytes?: number;
}

export interface PreparedBackupRestore {
  config: TimbreConfig;
  files: RestoreFileChange[];
}

export function createBackup(dataDir: string, config: TimbreConfig, options: CreateBackupOptions = {}): Buffer {
  mkdirSync(dataDir, { recursive: true });
  const root = realpathSync(dataDir);
  const contacts: Record<string, AddressBookContact[]> = Object.create(null) as Record<string, AddressBookContact[]>;
  const contactPins: Record<string, string> = Object.create(null) as Record<string, string>;
  const records: Record<string, Record<string, string>> = Object.create(null) as Record<string, Record<string, string>>;
  let remainingBytes = options.maxArchiveBytes;
  const readBackupFile = (file: string, label: string): string => {
    const read = readRegularFile(root, file, label, remainingBytes);
    if (remainingBytes !== undefined) remainingBytes -= read.bytesRead;
    return read.content;
  };
  for (const phone of config.phones) {
    validatePhoneId(phone.id);
    const phoneDirectory = path.join(root, 'phones', phone.id);
    const contactsPath = path.join(phoneDirectory, 'contacts.json');
    contacts[phone.id] = pathExists(contactsPath)
      ? parseContacts(readBackupFile(contactsPath, 'contacts'))
      : [];
    if (options.includeSecrets) {
      const pinsPath = path.join(phoneDirectory, 'contact-pins.json');
      if (pathExists(pinsPath)) contactPins[phone.id] = readBackupFile(pinsPath, 'contact PIN');
    }
    if (options.includeRecords) records[phone.id] = readDailyRecords(root, path.join(phoneDirectory, 'events'), readBackupFile);
  }
  return encodeBackup({
    config,
    contacts,
    ...(options.includeRecords ? { records } : {}),
    contactPins,
    includeSecrets: options.includeSecrets,
    passphrase: options.passphrase,
  }, { maxBytes: options.maxArchiveBytes });
}

export function prepareBackupRestore(dataDir: string, source: Uint8Array | string, passphrase?: string): PreparedBackupRestore {
  const restored: RestoredBackup = decodeBackup(source, passphrase);
  const config = normalizeConfig(restored.config);
  const root = pathExists(dataDir) ? realpathSync(dataDir) : path.resolve(dataDir);
  const phones = new Map(config.phones.map((phone) => [phone.id, phone]));
  for (const phoneId of [...Object.keys(restored.contacts), ...Object.keys(restored.records ?? {}), ...Object.keys(restored.contactPins)]) {
    if (!phones.has(phoneId)) throw new Error(`Backup data references an unknown phone: ${phoneId}`);
  }
  const files: RestoreFileChange[] = [{ path: 'timbre.yaml', content: Buffer.from(serializeConfigYaml(config), 'utf8') }];
  for (const phone of config.phones) {
    const phoneContacts = restored.contacts[phone.id] ?? [];
    validateContactNumbers(phoneContacts, phone.line.countryCode);
    const phoneDirectory = path.join(root, 'phones', phone.id);
    files.push({
      path: `phones/${phone.id}/contacts.json`,
      content: Buffer.from(`${JSON.stringify(phoneContacts, null, 2)}\n`, 'utf8'),
    });
    const pins = restored.contactPins[phone.id];
    files.push(pins === undefined
      ? { path: `phones/${phone.id}/contact-pins.json`, delete: true }
      : { path: `phones/${phone.id}/contact-pins.json`, content: Buffer.from(pins, 'utf8') });
    if (restored.records !== undefined) {
      const incoming = restored.records[phone.id] ?? {};
      const existingNames = listDailyRecordNames(root, path.join(phoneDirectory, 'events'));
      for (const name of existingNames) if (!(name in incoming)) files.push({ path: `phones/${phone.id}/events/${name}`, delete: true });
      for (const [name, content] of Object.entries(incoming)) {
        files.push({ path: `phones/${phone.id}/events/${name}`, content: Buffer.from(content, 'utf8') });
      }
    }
  }
  return { config, files };
}

function readDailyRecords(root: string, directory: string, readFile: (file: string, label: string) => string): Record<string, string> {
  const records: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of listDailyRecordNames(root, directory)) {
    const file = path.join(directory, name);
    records[name] = readFile(file, 'daily event record');
  }
  return records;
}

function listDailyRecordNames(root: string, directory: string): string[] {
  assertNoSymlinkParents(root, directory);
  if (!pathExists(directory)) return [];
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Daily event records directory is not a safe directory.');
  return readdirSync(directory).filter((name) => DAY_FILE.test(name)).sort();
}

function readRegularFile(root: string, file: string, label: string, maxBytes?: number): { content: string; bytesRead: number } {
  assertNoSymlinkParents(root, file);
  const stat = lstatSync(file);
  if (maxBytes !== undefined && stat.size > maxBytes) throw new BackupSizeLimitError();
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Backup ${label} file is not a regular file.`);
  if (maxBytes === undefined) return { content: readFileSync(file, 'utf8'), bytesRead: stat.size };
  const fd = openSync(file, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let content = '';
    let bytesRead = 0;
    while (true) {
      const length = Math.min(chunk.length, maxBytes - bytesRead + 1);
      const count = readSync(fd, chunk, 0, length, null);
      if (count === 0) break;
      bytesRead += count;
      if (bytesRead > maxBytes) throw new BackupSizeLimitError();
      content += decoder.write(chunk.subarray(0, count));
    }
    return { content: content + decoder.end(), bytesRead };
  } finally {
    closeSync(fd);
  }
}

function assertNoSymlinkParents(root: string, target: string): void {
  const relative = path.relative(root, path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Backup source path is outside the data directory.');
  let current = root;
  const parts = relative.split(path.sep);
  for (const part of parts) {
    current = path.join(current, part);
    if (!pathExists(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Backup source path crosses a symbolic link.');
    if (current !== path.resolve(target) && !stat.isDirectory()) throw new Error('Backup source path parent is not a directory.');
  }
}

function pathExists(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

function parseContacts(content: string): AddressBookContact[] {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('Backup contacts file is invalid JSON.'); }
  if (!Array.isArray(parsed)) throw new Error('Backup contacts file is not a list.');
  return parsed as AddressBookContact[];
}

function validateContactNumbers(contacts: AddressBookContact[], countryCode: string): void {
  for (const contact of contacts) {
    for (const number of contact.numbers) {
      let normalized: string;
      try { normalized = normalizeAddressBookNumber(number, countryCode); }
      catch { throw new Error(`Backup contact ${contact.id} contains an invalid phone number.`); }
      if (normalized !== number) throw new Error(`Backup contact ${contact.id} contains a non-normalized phone number.`);
    }
  }
}

function validatePhoneId(phoneId: string): void {
  if (!PHONE_ID.test(phoneId)) throw new Error(`Invalid phone ID in config: ${phoneId}`);
}
