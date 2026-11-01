import type { AddressBookContact } from '../contacts/contact.js';
import { resolveActiveScheduleSlot } from './schedule.js';
import {
  decide, findContact, isBlocked, normalizeNumber,
  type DecideContext, type Decision, type PhoneContact, type PhoneContactPermissions, type PhoneContactPolicy, type PhoneLineConfig,
} from './phone-config.js';
import type { SpamScoreAssessment } from './spam-score.js';
import type { SmsAutoReplyPolicy } from './sms-auto-reply-policy.js';

export interface InboundRule extends Partial<PhoneContactPermissions> {
  kind: 'contact' | 'group' | 'number';
  value: string;
}

export type InboundHandlingAction = 'standard' | 'always-through' | 'message' | 'block';

export const INBOUND_HANDLING_ACTION_OPTIONS: Array<{ label: string; value: InboundHandlingAction }> = [
  { label: 'Standard handling', value: 'standard' },
  { label: 'Always put through', value: 'always-through' },
  { label: 'Take a message', value: 'message' },
  { label: 'Block caller', value: 'block' },
];

export function isHandlingAction(value: unknown): value is InboundHandlingAction {
  return INBOUND_HANDLING_ACTION_OPTIONS.some((option) => option.value === value);
}

export interface InboundHandlingPolicy {
  action: InboundHandlingAction;
  greeting: string;
  instructions: string;
  smsAutoReply: SmsAutoReplyPolicy;
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

export interface SpamActionDecision {
  action: 'block' | 'screen';
  score: number;
  autoBlock: boolean;
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

function contactPolicyMatchesContact(policy: PhoneContactPolicy, contact: AddressBookContact, countryCode: string): boolean {
  if (policy.contactId && policy.contactId !== contact.id) return false;
  if (!policy.contactId && !policy.pattern) return false;
  if (!policy.pattern) return true;
  return contact.numbers.some((raw) => {
    const number = normalizeNumber(raw, countryCode);
    return number !== null && matchNumberRule(policy.pattern!, number, countryCode);
  });
}

export function hasContactRuleForContact(contact: AddressBookContact, cfg: PhoneLineConfig): boolean {
  return cfg.contactRules.some((policy) => contactPolicyMatchesContact(policy, contact, cfg.countryCode));
}

function blockedByContactRule(number: string, cfg: PhoneLineConfig, contacts: AddressBookContact[]): boolean {
  return cfg.contactRules.some((policy) => {
    if (policy.role !== 'blocked') return false;
    if (policy.pattern && !matchNumberRule(policy.pattern, number, cfg.countryCode)) return false;
    if (policy.contactId) {
      return contacts.some((contact) => contact.id === policy.contactId && contactHasNumber(contact, number, cfg.countryCode));
    }
    return !!policy.pattern;
  });
}

/** The handling action chosen for this caller, independent of the access gate. */
export function resolveInboundHandling(
  rawNumber: string,
  cfg: PhoneLineConfig,
  contacts: AddressBookContact[] = [],
  now: Date = new Date(),
): InboundHandlingPolicy {
  const number = normalizeNumber(rawNumber, cfg.countryCode);
  const matched = number ? contacts.filter((contact) => contactHasNumber(contact, number, cfg.countryCode)) : [];
  const contactRule = cfg.inboundHandling.rules.find((rule) =>
    rule.kind === 'contact' && matched.some((contact) => contact.id === rule.value));
  const groupRule = contactRule ? undefined : cfg.inboundHandling.rules.find((rule) =>
    rule.kind === 'group' && matched.some((contact) => contact.group.trim().toLocaleLowerCase() === rule.value.trim().toLocaleLowerCase()));
  const policy = contactRule ?? groupRule ?? resolveActiveScheduleSlot(cfg.schedule, now) ?? cfg.inboundHandling.default;
  if (cfg.inboundMode === 'normal') return policy;
  return { ...policy, action: cfg.inboundMode === 'busy' ? 'message' : 'block' };
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

function phoneContact(
  contact: AddressBookContact | null,
  number: string,
  policy?: PhoneContactPolicy,
  fallbackLabel = 'Allowed caller',
  rulePermissions?: Partial<PhoneContactPermissions>,
): PhoneContact {
  const owner = policy?.role === 'owner' || contact?.isUser === true;
  return {
    ...(policy?.contactId || contact?.id ? { contactId: policy?.contactId ?? contact!.id } : {}),
    label: policy?.label || contact?.name || fallbackLabel,
    pattern: number,
    role: owner ? 'owner' : 'trusted',
    callIn: policy?.callIn ?? (owner ? true : rulePermissions?.callIn ?? true),
    callOut: policy?.callOut ?? (owner ? true : rulePermissions?.callOut ?? false),
    smsIn: policy?.smsIn ?? (owner ? true : rulePermissions?.smsIn ?? false),
    smsOut: policy?.smsOut ?? (owner ? true : rulePermissions?.smsOut ?? false),
    conf: policy?.conf ?? (owner ? true : rulePermissions?.conf ?? false),
    pin: policy?.pin ?? '',
    messages: policy?.messages ?? false,
  };
}

function decideUnknownCaller(cfg: PhoneLineConfig, rawNumber: string, number: string | null, label: string): Decision {
  const legacy = number ? findContact(rawNumber, cfg) : null;
  if (legacy && !legacy.callIn) return { allow: false, reason: `call.in is off for ${legacy.label || 'this number'}` };
  switch (cfg.screening.unknownCallers) {
    case 'allow':
      return { allow: true, contact: legacy ?? phoneContact(null, number ?? '', undefined, label), number: number ?? '' };
    case 'block':
      return { allow: false, reason: number ? 'unknown caller is blocked' : 'private caller is blocked' };
    case 'screen':
      return { allow: false, reason: number ? 'not listed' : 'withheld or invalid number' };
  }
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
    if (privateCaller(rawNumber)) {
      if (!cfg.screening.acceptPrivate) return { allow: false, reason: 'private caller is not allowed' };
      return decideUnknownCaller(cfg, rawNumber, null, 'Private caller');
    }
    return { allow: false, reason: 'withheld or invalid number' };
  }

  if (isBlocked(number, cfg)
    || cfg.screening.block.some((rule) => ruleMatches(rule, number, contacts, cfg.countryCode))
    || blockedByContactRule(number, cfg, contacts)) {
    return { allow: false, reason: 'blocked' };
  }

  const rule = cfg.screening.allow.find((candidate) => ruleMatches(candidate, number, contacts, cfg.countryCode));
  const addressBookContact = contacts.find((contact) => contactHasNumber(contact, number, cfg.countryCode)) ?? null;
  const legacy = findContact(rawNumber, cfg);
  if (!addressBookContact && !rule && !legacy) return decideUnknownCaller(cfg, rawNumber, number, 'Unknown caller');

  if (!cfg.screening.allow.length || legacy?.role === 'owner') return decide('call.in', rawNumber, cfg, context);
  if (!rule) return { allow: false, reason: 'not on allow list' };

  if (legacy && !legacy.callIn) return { allow: false, reason: `call.in is off for ${legacy.label || 'this number'}` };
  if (rule.callIn === false) return { allow: false, reason: `call.in is off for ${rule.kind} allow rule` };
  return {
    allow: true,
    contact: legacy
      ? { ...legacy, ...(legacy.contactId || !addressBookContact ? {} : { contactId: addressBookContact.id }) }
      : phoneContact(addressBookContact, number, undefined, 'Allowed caller', rule),
    number,
  };
}

/** Applies spam scoring only to unlisted callers after the access decision. */
export function decideSpamAction(
  decision: Decision,
  config: PhoneLineConfig['spam'],
  assessment: SpamScoreAssessment,
): SpamActionDecision | null {
  if (decision.allow || decision.reason !== 'not listed') return null;
  if (assessment.autoBlock) return { action: 'block', score: assessment.score, autoBlock: true };
  if (assessment.score < config.threshold) return null;
  return { action: config.action, score: assessment.score, autoBlock: false };
}

/** Derives the legacy line contact view from address-book identities, rules, and the inbound allow list. */
export function projectPhoneContacts(cfg: PhoneLineConfig, contacts: AddressBookContact[]): PhoneContact[] {
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  const projected: PhoneContact[] = [];
  const keys = new Set<string>();
  const add = (contact: AddressBookContact | null, pattern: string, policy?: PhoneContactPolicy, permissions?: Partial<PhoneContactPermissions>) => {
    if (policy?.role === 'blocked' || (!pattern && policy?.pattern === undefined)) return;
    const policyKey = policy ? [policy.role, policy.callIn, policy.callOut, policy.smsIn, policy.smsOut, policy.conf, policy.pin, policy.messages].join(':') : '';
    const permissionsKey = permissions ? [permissions.callIn, permissions.callOut, permissions.smsIn, permissions.smsOut, permissions.conf].join(':') : '';
    const key = `${policy?.contactId ?? ''}\0${pattern}\0${policyKey}\0${permissionsKey}`;
    if (keys.has(key)) return;
    keys.add(key);
    projected.push(phoneContact(contact, pattern, policy, 'Allowed caller', permissions));
  };

  for (const policy of cfg.contactRules) {
    const contact = policy.contactId ? byId.get(policy.contactId) ?? null : null;
    if (policy.contactId && !contact) continue;
    if (policy.pattern) add(contact, policy.pattern, policy);
    else if (contact) for (const number of contact.numbers) add(contact, number, policy);
  }

  for (const contact of contacts) {
    if (hasContactRuleForContact(contact, cfg)) continue;
    const allowedNumbers = contact.numbers.flatMap((number) => {
      const normalized = normalizeNumber(number, cfg.countryCode);
      if (normalized === null) return [];
      const rule = cfg.screening.allow.find((candidate) => ruleMatches(candidate, normalized, contacts, cfg.countryCode));
      return rule ? [{ number, rule }] : [];
    });
    if (contact.isUser) {
      for (const number of contact.numbers) add(contact, number);
      continue;
    }
    for (const { number, rule } of allowedNumbers) add(contact, number, undefined, rule);
  }

  for (const rule of cfg.screening.allow) {
    if (rule.kind !== 'number') continue;
    const prefix = rule.value.trim().endsWith('*');
    const normalized = normalizeNumber(prefix ? rule.value.trim().slice(0, -1) : rule.value, cfg.countryCode);
    if (normalized) add(null, `${normalized}${prefix ? '*' : ''}`, undefined, rule);
  }

  return projected;
}
