import { createDecipheriv, createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { TimbreConfig } from '../config/timbre-config.js';
import type { AddressBookContact } from '../contacts/contact.js';
import type { RecordEvent } from '../records/event-types.js';

const FORMAT = 'timbre-backup';
const VERSION = 1;
const PHONE_ID = /^[\w-]{1,100}$/;
const CONTACT_ID = /^[\w-]{1,128}$/;
const EVENT_DAY = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const SECRET_KEY = /api.?key|token|password|secret|credential|^pin$|^headers$|^env$/i;
const EVENT_KINDS = new Set(['call', 'sms', 'system']);
const EVENT_TYPES = new Set([
  'contact.matched', 'call.started', 'call.blocked', 'call.answered', 'call.ended', 'call.outcome', 'call.transferred',
  'call.agent_started', 'conference.added', 'sms.received', 'sms.sent', 'policy.evaluated', 'notification.sent', 'retention.purged',
]);

export interface BackupInput {
  config: TimbreConfig;
  contacts: Record<string, AddressBookContact[]>;
  records?: Record<string, Record<string, string>>;
  contactPins: Record<string, string>;
  includeSecrets?: boolean;
  passphrase?: string;
}

export class BackupSizeLimitError extends RangeError {
  constructor() {
    super('Backup archive exceeds the configured size limit.');
    this.name = 'BackupSizeLimitError';
  }
}

export interface RestoredBackup {
  config: TimbreConfig;
  contacts: Record<string, AddressBookContact[]>;
  records?: Record<string, Record<string, string>>;
  contactPins: Record<string, string>;
}

interface SecretValue { path: Array<string | number>; value: string }
interface EncryptedSecrets {
  algorithm: 'scrypt-aes-256-gcm';
  salt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

interface Archive {
  format: typeof FORMAT;
  version: typeof VERSION;
  createdAt: string;
  config: TimbreConfig;
  contacts: Record<string, AddressBookContact[]>;
  records?: Record<string, Record<string, string>>;
  secrets?: EncryptedSecrets;
}

export function encodeBackup(input: BackupInput, options: { maxBytes?: number } = {}): Buffer {
  validateConfig(input.config);
  validateContacts(input.contacts);
  validateContactPins(input.contactPins);
  if (input.records !== undefined) validateRecords(input.records);
  const config = structuredClone(input.config) as unknown as Record<string, unknown>;
  const secretValues: SecretValue[] = [];
  scrubSecrets(config, [], secretValues);
  const archive: Archive = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    config: config as unknown as TimbreConfig,
    contacts: structuredClone(input.contacts),
    ...(input.records === undefined ? {} : { records: structuredClone(input.records) }),
  };
  if (input.includeSecrets) {
    if (typeof input.passphrase !== 'string' || input.passphrase.length < 8 || input.passphrase.length > 1024) {
      throw new Error('A passphrase between 8 and 1024 characters is required to include secrets.');
    }
    archive.secrets = encryptSecrets(input.passphrase, { configValues: secretValues, contactPins: input.contactPins });
  }
  if (options.maxBytes !== undefined && jsonSizeBytes(archive) > options.maxBytes) throw new BackupSizeLimitError();
  return Buffer.from(JSON.stringify(archive), 'utf8');
}

export function decodeBackup(source: Uint8Array | string, passphrase?: string): RestoredBackup {
  let archive: unknown;
  try { archive = JSON.parse(typeof source === 'string' ? source : Buffer.from(source).toString('utf8')); }
  catch { throw new Error('Backup archive is not valid JSON.'); }
  if (!isObject(archive) || archive.format !== FORMAT) throw new Error('Backup archive format is invalid.');
  if (archive.version !== VERSION) throw new Error(`Unsupported backup archive version: ${String(archive.version)}.`);
  if (typeof archive.createdAt !== 'string' || !Number.isFinite(Date.parse(archive.createdAt))) throw new Error('Backup archive timestamp is invalid.');
  if (!isObject(archive.config)) throw new Error('Backup config is invalid.');
  validateConfig(archive.config);
  validateContacts(archive.contacts);
  if (archive.records !== undefined) validateRecords(archive.records);
  assertNoUnsafeObjectKeys(archive);

  const config = structuredClone(archive.config) as unknown as TimbreConfig;
  let contactPins: Record<string, string> = {};
  if (archive.secrets !== undefined) {
    if (!passphrase) throw new Error('This backup contains encrypted secrets; enter its passphrase.');
    if (passphrase.length > 1024) throw new Error('Backup passphrase is longer than 1024 characters.');
    const secretPayload = decryptSecrets(archive.secrets, passphrase);
    if (!isObject(secretPayload) || !Array.isArray(secretPayload.configValues) || !isObject(secretPayload.contactPins)) {
      throw new Error('Backup encrypted secret data is invalid.');
    }
    const configRecord = config as unknown as Record<string, unknown>;
    for (const item of secretPayload.configValues) {
      if (!isObject(item) || !Array.isArray(item.path) || typeof item.value !== 'string'
        || !item.path.every((part) => typeof part === 'string' || Number.isInteger(part))) {
        throw new Error('Backup encrypted config secrets are invalid.');
      }
      restoreSecret(configRecord, item.path as Array<string | number>, item.value);
    }
    contactPins = Object.create(null) as Record<string, string>;
    for (const [phoneId, value] of Object.entries(secretPayload.contactPins)) {
      if (!PHONE_ID.test(phoneId) || typeof value !== 'string') throw new Error('Backup contact PIN data is invalid.');
      validatePinFile(value);
      contactPins[phoneId] = value;
    }
  }
  return {
    config,
    contacts: structuredClone(archive.contacts) as Record<string, AddressBookContact[]>,
    ...(archive.records === undefined ? {} : { records: structuredClone(archive.records) as Record<string, Record<string, string>> }),
    contactPins,
  };
}

function encryptSecrets(passphrase: string, payload: { configValues: SecretValue[]; contactPins: Record<string, string> }): EncryptedSecrets {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    algorithm: 'scrypt-aes-256-gcm',
    salt: salt.toString('hex'), nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptSecrets(value: unknown, passphrase: string): unknown {
  if (!isObject(value) || value.algorithm !== 'scrypt-aes-256-gcm'
    || typeof value.salt !== 'string' || !/^[a-f\d]{32}$/.test(value.salt)
    || typeof value.nonce !== 'string' || !/^[a-f\d]{24}$/.test(value.nonce)
    || typeof value.tag !== 'string' || !/^[a-f\d]{32}$/.test(value.tag)
    || typeof value.ciphertext !== 'string' || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value.ciphertext)) {
    throw new Error('Backup encrypted secret data is invalid.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(passphrase, Buffer.from(value.salt, 'hex'), 32), Buffer.from(value.nonce, 'hex'));
    decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error('Backup passphrase is incorrect or encrypted secrets are damaged.');
  }
}

function scrubSecrets(value: unknown, path: Array<string | number>, secrets: SecretValue[], parentSecret = false): unknown {
  if (typeof value === 'string') {
    if (parentSecret) {
      if (value) secrets.push({ path, value });
      return '';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => scrubSecrets(entry, [...path, index], secrets, parentSecret));
  }
  if (!isObject(value)) return value;
  for (const [key, entry] of Object.entries(value)) {
    const secret = parentSecret || SECRET_KEY.test(key);
    if (secret && entry === null) continue;
    value[key] = scrubSecrets(entry, [...path, key], secrets, secret);
  }
  return value;
}

function restoreSecret(root: Record<string, unknown>, parts: Array<string | number>, value: string): void {
  if (parts.length < 2 || parts.some((part) => typeof part === 'string' && ['__proto__', 'constructor', 'prototype'].includes(part))) {
    throw new Error('Backup encrypted config secret path is invalid.');
  }
  let parent: unknown = root;
  for (const part of parts.slice(0, -1)) {
    parent = Array.isArray(parent) && typeof part === 'number'
      ? parent[part]
      : isObject(parent) && typeof part === 'string' ? parent[part] : undefined;
  }
  const last = parts.at(-1)!;
  const current = Array.isArray(parent) && typeof last === 'number'
    ? parent[last]
    : isObject(parent) && typeof last === 'string' ? parent[last] : undefined;
  if (typeof current !== 'string' || current !== '') {
    throw new Error('Backup encrypted config secret path does not match its config.');
  }
  if (Array.isArray(parent) && typeof last === 'number') parent[last] = value;
  else if (isObject(parent) && typeof last === 'string') parent[last] = value;
  else throw new Error('Backup encrypted config secret path does not match its config.');
}

function validateConfig(value: unknown): asserts value is TimbreConfig {
  if (!isObject(value) || !Array.isArray(value.phones) || !value.phones.length
    || !Array.isArray(value.llms) || !value.llms.length || !isObject(value.web)) throw new Error('Backup config is invalid.');
  const phoneIds = new Set<string>();
  for (const phone of value.phones) {
    if (!isObject(phone) || typeof phone.id !== 'string' || !PHONE_ID.test(phone.id) || phoneIds.has(phone.id)
      || !isObject(phone.line) || !Array.isArray(phone.mcpServers)) throw new Error('Backup phone config is invalid.');
    phoneIds.add(phone.id);
  }
  const llmIds = new Set<string>();
  for (const llm of value.llms) {
    if (!isObject(llm) || typeof llm.id !== 'string' || !llm.id || llmIds.has(llm.id)
      || (llm.kind !== 'api' && llm.kind !== 'cli')) throw new Error('Backup LLM config is invalid.');
    llmIds.add(llm.id);
  }
  if (typeof value.web.port !== 'number' || typeof value.web.lan !== 'boolean' || typeof value.web.token !== 'string') {
    throw new Error('Backup web config is invalid.');
  }
}

function validateContacts(value: unknown): asserts value is Record<string, AddressBookContact[]> {
  if (!isObject(value)) throw new Error('Backup contacts are invalid.');
  for (const [phoneId, contacts] of Object.entries(value)) {
    if (!PHONE_ID.test(phoneId) || !Array.isArray(contacts)) throw new Error('Backup contacts contain an invalid phone ID.');
    for (const contact of contacts) {
      if (!isObject(contact) || typeof contact.id !== 'string' || !CONTACT_ID.test(contact.id)
        || typeof contact.name !== 'string' || !contact.name.trim() || !Array.isArray(contact.numbers) || !contact.numbers.length
        || !contact.numbers.every((number) => typeof number === 'string') || typeof contact.group !== 'string'
        || typeof contact.trusted !== 'boolean' || typeof contact.isUser !== 'boolean') {
        throw new Error('Backup contains an invalid contact.');
      }
    }
  }
}

function validateRecords(value: unknown): asserts value is Record<string, Record<string, string>> {
  if (!isObject(value)) throw new Error('Backup event records are invalid.');
  for (const [phoneId, files] of Object.entries(value)) {
    if (!PHONE_ID.test(phoneId) || !isObject(files)) throw new Error('Backup event records contain an invalid phone ID.');
    for (const [name, content] of Object.entries(files)) {
      const match = EVENT_DAY.exec(name);
      if (!match || !isCalendarDay(match[1], Number(match[2]), Number(match[3])) || typeof content !== 'string') {
        throw new Error('Backup event record filename or content is invalid.');
      }
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event: unknown;
        try { event = JSON.parse(line); } catch { throw new Error(`Backup event record ${name} contains invalid JSON.`); }
        if (!isRecordEvent(event)) throw new Error(`Backup event record ${name} contains an invalid event.`);
      }
    }
  }
}

function validatePinFile(content: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('Backup contact PIN data is invalid.'); }
  if (!isObject(parsed)) throw new Error('Backup contact PIN data is invalid.');
  for (const [id, value] of Object.entries(parsed)) {
    if (!CONTACT_ID.test(id) || !isObject(value)
      || (value.salt !== undefined && (typeof value.salt !== 'string' || !/^[a-f\d]{32}$/.test(value.salt)))
      || (value.hash !== undefined && (typeof value.hash !== 'string' || !/^[a-f\d]{128}$/.test(value.hash)))
      || (value.needsReentry !== undefined && value.needsReentry !== true)) {
      throw new Error('Backup contact PIN data is invalid.');
    }
    if (!!value.salt !== !!value.hash && value.needsReentry !== true) throw new Error('Backup contact PIN data is invalid.');
  }
}

function validateContactPins(value: unknown): asserts value is Record<string, string> {
  if (!isObject(value)) throw new Error('Backup contact PIN data is invalid.');
  for (const [phoneId, content] of Object.entries(value)) {
    if (!PHONE_ID.test(phoneId) || typeof content !== 'string') throw new Error('Backup contact PIN data is invalid.');
    validatePinFile(content);
  }
}

function isRecordEvent(value: unknown): value is RecordEvent {
  if (!isObject(value)) return false;
  return typeof value.eventId === 'string' && !!value.eventId
    && typeof value.interactionId === 'string' && !!value.interactionId
    && typeof value.kind === 'string' && EVENT_KINDS.has(value.kind)
    && typeof value.type === 'string' && EVENT_TYPES.has(value.type)
    && typeof value.occurredAt === 'string' && Number.isFinite(Date.parse(value.occurredAt))
    && isObject(value.details);
}

function isCalendarDay(year: string, month: number, day: number): boolean {
  const date = new Date(Date.UTC(Number(year), month - 1, day));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function jsonSizeBytes(value: unknown, inArray = false): number {
  if (value === null) return 4;
  if (typeof value === 'string') return jsonStringSizeBytes(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return Buffer.byteLength(JSON.stringify(value)!, 'utf8');
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return inArray ? 4 : 0;
  }
  if (Array.isArray(value)) {
    return 2 + value.reduce((size, entry, index) =>
      size + (index === 0 ? 0 : 1) + jsonSizeBytes(entry, true), 0);
  }
  if (isObject(value)) {
    let size = 2;
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
      if (count++ > 0) size++;
      size += jsonStringSizeBytes(key) + 1 + jsonSizeBytes(entry);
    }
    return size;
  }
  return Buffer.byteLength(JSON.stringify(value)!, 'utf8');
}

function jsonStringSizeBytes(value: string): number {
  let size = 2;
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 8192, value.length);
    if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) end--;
    size += Buffer.byteLength(JSON.stringify(value.slice(start, end))!, 'utf8') - 2;
    start = end;
  }
  return size;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function assertNoUnsafeObjectKeys(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(assertNoUnsafeObjectKeys); return; }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Backup archive contains an unsafe field.');
    assertNoUnsafeObjectKeys(child);
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
