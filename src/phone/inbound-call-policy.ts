import type { AddressBookContact } from '../contacts/contact.js';
import {
  decide, findContact, isBlocked, normalizeNumber,
  type DecideContext, type Decision, type PhoneContact, type PhoneContactPolicy, type PhoneLineConfig,
} from './phone-config.js';

export interface InboundRule {
  kind: 'contact' | 'group' | 'number';
  value: string;
}

export type InboundHandlingAction = 'standard' | 'always-through' | 'message' | 'block';

export interface InboundHandlingPolicy {
  action: InboundHandlingAction;
  greeting: string;
  instructions: string;
}

export interface InboundHandlingRule extends InboundHandlingPolicy {
  kind: 'contact' | 'group';
  value: string;
}

export interface InboundHandlingConfig {
  default: InboundHandlingPolicy;
  rules: InboundHandlingRule[];
}

export interface InboundScreening {
  allow: InboundRule[];
  block: InboundRule[];
  acceptPrivate: boolean;
}

function privateCaller(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return !value || /^(private|withheld|restricted|anonymous|unknown)( caller| number)?$/.test(value) || value === 'no caller id';
}

function matchNumberRule(value: string, number: string, countryCode: string): boolean {
  const raw = value.trim();
  const prefix = raw.endsWith('*');
  const normalized = normalizeNumber(prefix ? raw.slice(0, -1) : raw, countryCode);
  return normalized !== null && (prefix ? number.startsWith(normalized) : number === normalized);
}

function contactHasNumber(contact: AddressBookContact, number: string, countryCode: string): boolean {
  return contact.numbers.some((raw) => normalizeNumber(raw, countryCode) === number);
}

/** The handling action chosen for this caller, independent of the access gate. */
export function resolveInboundHandling(
  rawNumber: string,
  cfg: PhoneLineConfig,
  contacts: AddressBookContact[] = [],
): InboundHandlingPolicy {
  const number = normalizeNumber(rawNumber, cfg.countryCode);
  const matched = number ? contacts.filter((contact) => contactHasNumber(contact, number, cfg.countryCode)) : [];
  const contactRule = cfg.inboundHandling.rules.find((rule) =>
    rule.kind === 'contact' && matched.some((contact) => contact.id === rule.value));
  if (contactRule) return contactRule;

  const groupRule = cfg.inboundHandling.rules.find((rule) =>
    rule.kind === 'group' && matched.some((contact) => contact.group.trim().toLocaleLowerCase() === rule.value.trim().toLocaleLowerCase()));
  return groupRule ?? cfg.inboundHandling.default;
}

function matchingContact(rule: InboundRule, number: string, contacts: AddressBookContact[], countryCode: string): AddressBookContact | null {
  if (rule.kind === 'contact') {
    const contact = contacts.find((item) => item.id === rule.value);
    return contact && contactHasNumber(contact, number, countryCode) ? contact : null;
  }
  if (rule.kind === 'group') {
    const group = rule.value.trim().toLocaleLowerCase();
    return contacts.find((item) => item.group.trim().toLocaleLowerCase() === group && contactHasNumber(item, number, countryCode)) ?? null;
  }
  return contacts.find((item) => contactHasNumber(item, number, countryCode)) ?? null;
}

function ruleMatches(rule: InboundRule, number: string, contacts: AddressBookContact[], countryCode: string): boolean {
  return rule.kind === 'number'
    ? matchNumberRule(rule.value, number, countryCode)
    : matchingContact(rule, number, contacts, countryCode) !== null;
}

function phoneContact(contact: AddressBookContact | null, number: string, policy?: PhoneContactPolicy): PhoneContact {
  return {
    label: policy?.label || contact?.name || 'Allowed caller',
    pattern: number,
    role: policy?.role === 'owner' || contact?.isUser ? 'owner' : 'trusted',
    callIn: policy?.callIn ?? true,
    callOut: policy?.callOut ?? false,
    smsIn: policy?.smsIn ?? false,
    smsOut: policy?.smsOut ?? false,
    conf: policy?.conf ?? false,
    pin: policy?.pin ?? '',
    messages: policy?.messages ?? false,
  };
}

/** Applies the new screening gate, then preserves the legacy per-contact call permission. */
export function decideInboundCall(
  rawNumber: string,
  cfg: PhoneLineConfig,
  contacts: AddressBookContact[] = [],
  context: DecideContext = { now: new Date(), callsLastHour: 0, smsLastHour: 0 },
): Decision {
  if (!cfg.masters.callIn) return { allow: false, reason: 'call.in is switched off' };

  const number = normalizeNumber(rawNumber, cfg.countryCode);
  if (!number) {
    if (privateCaller(rawNumber) && !cfg.screening.acceptPrivate) return { allow: false, reason: 'private caller is not allowed' };
    return { allow: false, reason: 'withheld or invalid number' };
  }

  if (isBlocked(number, cfg) || cfg.screening.block.some((rule) => ruleMatches(rule, number, contacts, cfg.countryCode))) {
    return { allow: false, reason: 'blocked' };
  }

  if (!cfg.screening.allow.length) return decide('call.in', rawNumber, cfg, context);

  const rule = cfg.screening.allow.find((candidate) => ruleMatches(candidate, number, contacts, cfg.countryCode));
  if (!rule) return { allow: false, reason: 'not on allow list' };

  const addressBookContact = rule.kind === 'number'
    ? contacts.find((contact) => contactHasNumber(contact, number, cfg.countryCode)) ?? null
    : matchingContact(rule, number, contacts, cfg.countryCode);
  const legacy = findContact(rawNumber, cfg);
  if (legacy && !legacy.callIn) return { allow: false, reason: `call.in is off for ${legacy.label || 'this number'}` };
  return { allow: true, contact: legacy ?? phoneContact(addressBookContact, number), number };
}

function policyContact(contact: AddressBookContact | null, number: string, policy?: PhoneContactPolicy): PhoneContact {
  return phoneContact(contact, number, policy);
}

/** Derives the legacy line contact view from address-book identities, rules, and the inbound allow list. */
export function projectPhoneContacts(cfg: PhoneLineConfig, contacts: AddressBookContact[]): PhoneContact[] {
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  const projected: PhoneContact[] = [];
  const keys = new Set<string>();
  const add = (contact: AddressBookContact | null, pattern: string, policy?: PhoneContactPolicy) => {
    if (policy?.role === 'blocked' || (!pattern && policy?.pattern === undefined)) return;
    const permissions = policy ? [policy.role, policy.callIn, policy.callOut, policy.smsIn, policy.smsOut, policy.conf, policy.pin, policy.messages].join(':') : '';
    const key = `${policy?.contactId ?? ''}\0${pattern}\0${permissions}`;
    if (keys.has(key)) return;
    keys.add(key);
    projected.push(policyContact(contact, pattern, policy));
  };

  for (const policy of cfg.contactRules) {
    const contact = policy.contactId ? byId.get(policy.contactId) ?? null : null;
    if (policy.contactId && !contact) continue;
    if (policy.pattern) add(contact, policy.pattern, policy);
    else if (contact) for (const number of contact.numbers) add(contact, number, policy);
  }

  for (const contact of contacts) {
    if (cfg.contactRules.some((policy) => policy.contactId === contact.id)) continue;
    const allowed = cfg.screening.allow.some((rule) => contact.numbers.some((number) => {
      const normalized = normalizeNumber(number, cfg.countryCode);
      return normalized !== null && ruleMatches(rule, normalized, contacts, cfg.countryCode);
    }));
    if (!allowed) continue;
    for (const number of contact.numbers) add(contact, number);
  }

  return projected;
}
