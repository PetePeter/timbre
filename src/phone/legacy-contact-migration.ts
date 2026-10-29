import { createHash } from 'node:crypto';
import type { AddressBookContactInput } from '../contacts/contact.js';
import { ContactsStore } from '../contacts/contacts-store.js';
import { DEFAULT_PHONE_LINE_CONFIG, normalizeNumber, patternToRegex, type PhoneContact, type PhoneContactPolicy } from './phone-config.js';

interface LegacyRow extends Omit<PhoneContact, 'role'> { role: PhoneContact['role'] | 'blocked' }

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function contactRows(value: unknown, ownerPin: unknown): LegacyRow[] {
  if (!Array.isArray(value)) return [];
  const oldPin = typeof ownerPin === 'string' && /^\d{6,}$/.test(ownerPin) ? ownerPin : '';
  return value.flatMap((entry): LegacyRow[] => {
    const row = object(entry);
    if (!row) return [];
    const oldRole = row.role ?? 'trusted';
    if (oldRole !== 'owner' && oldRole !== 'trusted' && oldRole !== 'blocked') return [];
    const role = oldRole === 'owner' && typeof row.pattern === 'string' && row.pattern.trim().endsWith('*') ? 'trusted' : oldRole;
    const pin = typeof row.pin === 'string' && /^\d{6,}$/.test(row.pin) ? row.pin : role === 'owner' ? oldPin : '';
    return [{
      label: typeof row.label === 'string' ? row.label : '',
      pattern: typeof row.pattern === 'string' ? row.pattern : '',
      role,
      callIn: typeof row.callIn === 'boolean' ? row.callIn : false,
      callOut: typeof row.callOut === 'boolean' ? row.callOut : false,
      smsIn: typeof row.smsIn === 'boolean' ? row.smsIn : false,
      smsOut: typeof row.smsOut === 'boolean' ? row.smsOut : false,
      conf: typeof row.conf === 'boolean' ? row.conf : false,
      pin,
      messages: typeof row.messages === 'boolean' ? row.messages : role === 'owner',
    }];
  });
}

function stableLegacyId(phoneId: string, index: number, row: LegacyRow): string {
  const hex = createHash('sha256').update(`${phoneId}\0${index}\0${row.label}\0${row.pattern}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function canonicalPattern(pattern: string, countryCode: string): string {
  const value = pattern.trim();
  const prefix = value.endsWith('*');
  const normalized = normalizeNumber(prefix ? value.slice(0, -1) : value, countryCode);
  return normalized ? `${normalized}${prefix ? '*' : ''}` : value;
}

function identity(row: LegacyRow, number: string): AddressBookContactInput {
  return {
    name: row.label.trim() || number,
    numbers: [number],
    group: '',
    trusted: row.role === 'owner' || row.role === 'trusted',
    isUser: row.role === 'owner',
  };
}

function policy(row: LegacyRow, countryCode: string, contactId?: string): PhoneContactPolicy {
  return {
    ...(contactId ? { contactId } : {}),
    pattern: canonicalPattern(row.pattern, countryCode),
    ...(!contactId ? { label: row.label } : {}),
    role: row.role,
    callIn: row.callIn,
    callOut: row.callOut,
    smsIn: row.smsIn,
    smsOut: row.smsOut,
    conf: row.conf,
    pin: row.pin,
    messages: row.messages,
  };
}

/** Imports old YAML line contacts before ConfigStore removes their duplicate identity fields. */
export function migrateLegacyPhoneContacts(raw: unknown, dataDir: string): { config: unknown; changed: boolean } {
  const config = object(structuredClone(raw ?? {}));
  if (!config || !Array.isArray(config.phones)) return { config: raw, changed: false };
  let changed = false;

  config.phones = config.phones.map((entry) => {
    const phone = object(entry);
    const line = phone && object(phone.line);
    if (!phone || !line || !Array.isArray(line.contacts)) return entry;
    const phoneId = typeof phone.id === 'string' ? phone.id : '';
    if (!phoneId || !/^[\w-]+$/.test(phoneId)) return entry;

    const countryCode = typeof line.countryCode === 'string' ? line.countryCode : DEFAULT_PHONE_LINE_CONFIG.countryCode;
    const rows = contactRows(line.contacts, line.ownerPin);
    const imports: Array<{ id: string; input: AddressBookContactInput; rowIndex: number }> = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const pattern = row.pattern.trim();
      if (!pattern || pattern.endsWith('*')) continue;
      const number = normalizeNumber(pattern, countryCode);
      if (number) imports.push({ id: stableLegacyId(phoneId, index, row), input: identity(row, number), rowIndex: index });
    }

    const imported = new ContactsStore(dataDir, phoneId, countryCode).importLegacy(imports);
    const importedIds = new Map(imports.map((item, index) => [item.rowIndex, imported[index].id]));
    const contactRules = Array.isArray(line.contactRules) ? [...line.contactRules] : [];
    const ruleKey = (item: unknown) => {
      const value = object(item);
      return JSON.stringify(value && {
        contactId: value.contactId ?? '', pattern: value.pattern ?? '', role: value.role ?? '',
        callIn: value.callIn ?? false, callOut: value.callOut ?? false, smsIn: value.smsIn ?? false,
        smsOut: value.smsOut ?? false, conf: value.conf ?? false, pin: value.pin ?? '', messages: value.messages ?? false,
      });
    };
    const ruleKeys = new Set(contactRules.map(ruleKey));
    const blocked: Array<{ kind: 'number'; value: string }> = [];

    rows.forEach((row, index) => {
      if (row.role === 'blocked') {
        const pattern = canonicalPattern(row.pattern, countryCode);
        if (pattern) blocked.push({ kind: 'number', value: pattern });
        return;
      }
      const contactId = importedIds.get(index);
      const rule = policy(row, countryCode, contactId);
      const key = ruleKey(rule);
      if (!ruleKeys.has(key)) {
        contactRules.push(rule);
        ruleKeys.add(key);
      }
    });

    const screening = object(line.screening) ?? {};
    const existingBlocks = Array.isArray(screening.block) ? screening.block : [];
    line.screening = { ...screening, block: [...existingBlocks, ...blocked] };
    const existingBlocklist = Array.isArray(line.blocklist) ? line.blocklist : [];
    const legacyBlockPatterns = new Set(blocked.map((rule) => patternToRegex(rule.value, countryCode)).filter((pattern): pattern is string => pattern !== null));
    line.blocklist = [...new Set(existingBlocklist.filter((pattern) => typeof pattern === 'string' && !legacyBlockPatterns.has(pattern)))];
    line.contactRules = contactRules;
    delete line.contacts;
    delete line.ownerPin;
    changed = true;
    return { ...phone, line };
  });

  return { config, changed };
}
