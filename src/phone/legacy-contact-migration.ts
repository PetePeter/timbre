import { createHash } from 'node:crypto';
import type { AddressBookContact, AddressBookContactInput } from '../contacts/contact.js';
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

function eligible(contact: AddressBookContact): boolean { return contact.isUser || contact.trusted; }

function candidates(rule: Record<string, unknown>, contacts: AddressBookContact[], countryCode: string): AddressBookContact[] {
  if (typeof rule.contactId === 'string' && rule.contactId) {
    return contacts.filter((contact) => contact.id === rule.contactId && eligible(contact));
  }
  if (typeof rule.pattern !== 'string' || !rule.pattern.trim()) return [];
  const prefix = rule.pattern.trim().endsWith('*');
  const pattern = normalizeNumber(prefix ? rule.pattern.trim().slice(0, -1) : rule.pattern, countryCode);
  if (!pattern) return [];
  return contacts.filter((contact) => eligible(contact) && contact.numbers.some((number) => {
    const normalized = normalizeNumber(number, countryCode);
    return normalized !== null && (prefix ? normalized.startsWith(pattern) : normalized === pattern);
  }));
}

function ruleKey(item: unknown): string {
  const value = object(item);
  return JSON.stringify(value && {
    contactId: value.contactId ?? '', pattern: value.pattern ?? '', role: value.role ?? '',
    callIn: value.callIn ?? false, callOut: value.callOut ?? false, smsIn: value.smsIn ?? false,
    smsOut: value.smsOut ?? false, conf: value.conf ?? false, messages: value.messages ?? false,
  });
}

/** Imports old YAML contacts and moves assignable plaintext PINs into per-contact hashes. */
export function migrateLegacyPhoneContacts(
  raw: unknown,
  dataDir: string,
  log: (message: string) => void = (message) => console.warn(message),
): { config: unknown; changed: boolean } {
  const config = object(structuredClone(raw ?? {}));
  if (!config || !Array.isArray(config.phones)) return { config: raw, changed: false };
  let changed = false;

  config.phones = config.phones.map((entry) => {
    const phone = object(entry);
    const line = phone && object(phone.line);
    if (!phone || !line) return entry;
    const phoneId = typeof phone.id === 'string' ? phone.id : '';
    if (!phoneId || !/^[\w-]+$/.test(phoneId)) return entry;

    const countryCode = typeof line.countryCode === 'string' ? line.countryCode : DEFAULT_PHONE_LINE_CONFIG.countryCode;
    const sourceRules = Array.isArray(line.contactRules) ? [...line.contactRules] : [];
    const oldRows = contactRows(line.contacts, line.ownerPin);
    if (!Array.isArray(line.contacts) && !('ownerPin' in line)
      && !sourceRules.some((value) => typeof object(value)?.pin === 'string' && (object(value)!.pin as string).length > 0)) return entry;

    const imports: Array<{ id: string; input: AddressBookContactInput; rowIndex: number }> = [];
    for (let index = 0; index < oldRows.length; index++) {
      const row = oldRows[index];
      const pattern = row.pattern.trim();
      if (!pattern || pattern.endsWith('*')) continue;
      const number = normalizeNumber(pattern, countryCode);
      if (number) imports.push({ id: stableLegacyId(phoneId, index, row), input: identity(row, number), rowIndex: index });
    }

    const contacts = new ContactsStore(dataDir, phoneId, countryCode, log);
    const imported = contacts.importLegacy(imports);
    const importedIds = new Map(imports.map((item, index) => [item.rowIndex, imported[index].id]));
    const contactRules = [...sourceRules];
    const ruleKeys = new Set(contactRules.map(ruleKey));
    const blocked: Array<{ kind: 'number'; value: string }> = [];

    oldRows.forEach((row, index) => {
      if (row.role === 'blocked') {
        const pattern = canonicalPattern(row.pattern, countryCode);
        if (pattern) blocked.push({ kind: 'number', value: pattern });
        return;
      }
      const rule = policy(row, countryCode, importedIds.get(index));
      const key = ruleKey(rule);
      if (!ruleKeys.has(key)) {
        contactRules.push(rule);
        ruleKeys.add(key);
      }
    });

    const pinValues = new Map<string, Set<string>>();
    const needsReentry = new Set<string>();
    let unresolvedPin = false;
    const registerPin = (pin: string, targets: AddressBookContact[], ambiguous: boolean) => {
      if (ambiguous || targets.length !== 1 || !/^\d{6,}$/.test(pin)) {
        unresolvedPin = true;
        for (const target of targets) needsReentry.add(target.id);
        return;
      }
      const values = pinValues.get(targets[0].id) ?? new Set<string>();
      values.add(pin);
      pinValues.set(targets[0].id, values);
    };

    const sanitizedRules = contactRules.map((value) => {
      const rule = object(value);
      if (!rule) return value;
      const pin = typeof rule.pin === 'string' ? rule.pin : '';
      const pattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : '';
      const isPrefix = pattern.endsWith('*');
      const matches = candidates(rule, contacts.list(), countryCode);
      if (pin) registerPin(pin, matches, isPrefix);
      const resolvedContact = !rule.contactId && !isPrefix && matches.length === 1 ? matches[0] : null;
      return {
        ...rule,
        ...(resolvedContact ? { contactId: resolvedContact.id, label: undefined } : {}),
        pin: '',
      };
    });

    const globalOwnerPin = typeof line.ownerPin === 'string' ? line.ownerPin : '';
    const rowHasGlobalPin = oldRows.some((row) => row.role === 'owner' && row.pin && row.pin === globalOwnerPin);
    if (globalOwnerPin && !rowHasGlobalPin && /^\d{6,}$/.test(globalOwnerPin)) {
      const ownerRuleTargets = sanitizedRules.flatMap((value) => {
        const rule = object(value);
        return rule?.role === 'owner' ? candidates(rule, contacts.list(), countryCode) : [];
      });
      const targets = ownerRuleTargets.length ? [...new Map(ownerRuleTargets.map((contact) => [contact.id, contact])).values()]
        : contacts.list().filter((contact) => contact.isUser && eligible(contact));
      registerPin(globalOwnerPin, targets, targets.length !== 1);
    }

    for (const [contactId, values] of pinValues) {
      if (values.size !== 1 || needsReentry.has(contactId)) {
        needsReentry.add(contactId);
        unresolvedPin = true;
        continue;
      }
      contacts.setPin(contactId, [...values][0]);
    }
    for (const contactId of needsReentry) contacts.markPinNeedsReentry(contactId);
    if (unresolvedPin) log('Legacy caller PIN was cleared because it could not be assigned safely; PIN needs re-entry.');

    const screening = object(line.screening) ?? {};
    const existingBlocks = Array.isArray(screening.block) ? screening.block : [];
    line.screening = { ...screening, block: [...existingBlocks, ...blocked] };
    const existingBlocklist = Array.isArray(line.blocklist) ? line.blocklist : [];
    const legacyBlockPatterns = new Set(blocked.map((rule) => patternToRegex(rule.value, countryCode)).filter((value): value is string => value !== null));
    line.blocklist = [...new Set(existingBlocklist.filter((pattern) => typeof pattern === 'string' && !legacyBlockPatterns.has(pattern)))];
    const finalKeys = new Set<string>();
    line.contactRules = sanitizedRules.filter((rule) => {
      const key = ruleKey(rule);
      if (finalKeys.has(key)) return false;
      finalKeys.add(key);
      return true;
    });
    delete line.contacts;
    delete line.ownerPin;
    changed = true;
    return { ...phone, line };
  });

  return { config, changed };
}
