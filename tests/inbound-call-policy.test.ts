import { describe, expect, it } from 'vitest';
import { decideInboundCall, decideSpamAction, dialString, projectPhoneContacts, resolveInboundHandling, type InboundRule } from '../src/phone/inbound-call-policy.js';
import { decide, resolvePhoneLineConfig } from '../src/phone/phone-config.js';
import type { AddressBookContact } from '../src/contacts/contact.js';

const contacts: AddressBookContact[] = [
  { id: 'maya', name: 'Maya Chen', numbers: ['+61491570156'], group: 'Family', trusted: true, isUser: false },
  { id: 'alex', name: 'Alex Morgan', numbers: ['+61280000101'], group: 'Work', trusted: false, isUser: false },
];
const owner: AddressBookContact = {
  id: 'owner', name: 'Me', numbers: ['+61400000001', '+61400000002'], group: '', trusted: true, isUser: true,
};

function config(screening: Partial<{ allow: InboundRule[]; block: InboundRule[]; acceptPrivate: boolean; unknownCallers: 'allow' | 'screen' | 'block' }> = {}) {
  return resolvePhoneLineConfig({
    screening: { allow: [], block: [], acceptPrivate: true, ...screening },
  });
}

describe('decideInboundCall', () => {
  it('defaults invalid or missing quick-control values to Normal and Screen', () => {
    expect(resolvePhoneLineConfig({}).inboundMode).toBe('normal');
    expect(resolvePhoneLineConfig({ inboundMode: 'offline', screening: { unknownCallers: 'ignore' } }))
      .toMatchObject({ inboundMode: 'normal', screening: { unknownCallers: 'screen' } });
  });

  it('allows a matching contact in the allow list', () => {
    const decision = decideInboundCall('+61491570156', config({ allow: [{ kind: 'contact', value: 'maya' }] }), contacts);

    expect(decision).toMatchObject({ allow: true, number: '+61491570156', contact: { label: 'Maya Chen', callIn: true } });
  });

  it('denies a blocked caller even when the same caller is allowed', () => {
    const decision = decideInboundCall('+61491570156', config({
      allow: [{ kind: 'contact', value: 'maya' }],
      block: [{ kind: 'contact', value: 'maya' }],
    }), contacts);

    expect(decision).toEqual({ allow: false, reason: 'blocked' });
  });

  it('matches number prefixes and denies a caller outside a non-empty allow list', () => {
    const prefix = decideInboundCall('+61280000199', config({ allow: [{ kind: 'number', value: '+612800001*' }] }), contacts);
    const unknown = decideInboundCall('+61400000000', config({ allow: [{ kind: 'group', value: 'Family' }] }), contacts);

    expect(prefix).toMatchObject({ allow: true, number: '+61280000199' });
    expect(unknown).toEqual({ allow: false, reason: 'not listed' });
  });

  it('honors an allow rule with Call in turned off', () => {
    const denied = decideInboundCall('+61491570156', config({ allow: [{ kind: 'contact', value: 'maya', callIn: false }] }), contacts);
    expect(denied).toEqual({ allow: false, reason: 'call.in is off for contact allow rule' });
  });

  it('keeps unknown callers on the code-only Reception path when no allow list is configured', () => {
    expect(decideInboundCall('+61400000000', config(), contacts)).toEqual({ allow: false, reason: 'not listed' });
  });

  it('projects every address-book owner number and allows the owner when the allow list is empty', () => {
    const cfg = config();
    const projected = projectPhoneContacts(cfg, [owner]);

    expect(projected.map((contact) => contact.pattern)).toEqual(owner.numbers);
    expect(projected.every((contact) => contact.role === 'owner')).toBe(true);
    expect(decideInboundCall(owner.numbers[0]!, { ...cfg, contacts: projected }, [owner]))
      .toMatchObject({ allow: true, number: owner.numbers[0], contact: { label: 'Me', role: 'owner' } });
  });

  it('defaults owner permissions on and lets an explicit per-contact rule override them', () => {
    const cfg = config({ allow: [{ kind: 'group', value: 'Family' }] });
    const projected = projectPhoneContacts(cfg, [owner]);

    expect(projected).toContainEqual(expect.objectContaining({
      contactId: owner.id, role: 'owner', callIn: true, callOut: true, smsIn: true, smsOut: true, conf: true,
    }));

    const explicit = resolvePhoneLineConfig({
      ...cfg,
      contactRules: [{
        contactId: owner.id, role: 'owner', callIn: true, callOut: true, smsIn: false, smsOut: true,
        conf: true, pin: '', messages: false,
      }],
    });
    expect(projectPhoneContacts(explicit, [owner])).toContainEqual(expect.objectContaining({
      contactId: owner.id, role: 'owner', callIn: true, callOut: true, smsIn: false, smsOut: true, conf: true,
    }));
  });

  it('projects allow-rule SMS permissions into the action policy', () => {
    const family = contacts[0]!;
    const cfg = resolvePhoneLineConfig({
      screening: { allow: [{ kind: 'group', value: 'Family', callIn: true, callOut: false, smsIn: true, smsOut: false, conf: false }], unknownCallers: 'block' },
    });
    const projected = projectPhoneContacts(cfg, [family]);
    const runtime = { ...cfg, contacts: projected };

    expect(projected).toContainEqual(expect.objectContaining({ label: family.name, smsIn: true }));
    expect(decide('sms.in', family.numbers[0]!, runtime, { now: new Date(), callsLastHour: 0, smsLastHour: 0 }))
      .toMatchObject({ allow: true, contact: { label: family.name, smsIn: true } });
  });

  it('projects number allow-rule permissions for senders without address-book contacts', () => {
    const number = '+61400000009';
    const cfg = resolvePhoneLineConfig({
      screening: { allow: [{ kind: 'number', value: number, callIn: true, callOut: false, smsIn: true, smsOut: false, conf: false }] },
    });
    const runtime = { ...cfg, contacts: projectPhoneContacts(cfg, []) };

    expect(decide('sms.in', number, runtime, { now: new Date(), callsLastHour: 0, smsLastHour: 0 }))
      .toMatchObject({ allow: true, number, contact: { pattern: number, smsIn: true } });
  });

  it('a country-wide +61* allow rule lets SMS out reach any national number, not international or blocked ones', () => {
    const cfg = resolvePhoneLineConfig({
      countryCode: '+61',
      blocklist: ['^\\+61400000000$'],
      screening: { allow: [{ kind: 'number', value: '+61*', callIn: false, callOut: true, smsIn: false, smsOut: true, conf: false }] },
    });
    const runtime = { ...cfg, contacts: projectPhoneContacts(cfg, []) };
    const now = { now: new Date(2026, 9, 28, 12, 0), callsLastHour: 0, smsLastHour: 0 };

    expect(decide('sms.out', '+61491570156', runtime, now)).toMatchObject({ allow: true, number: '+61491570156' });
    expect(decide('sms.out', '0491 570 156', runtime, now)).toMatchObject({ allow: true });
    expect(decide('sms.out', '+14155550100', runtime, now)).toMatchObject({ allow: false });
    expect(decide('sms.out', '+61400000000', runtime, now)).toEqual({ allow: false, reason: 'blocked' });
    expect(decide('sms.in', '+61491570156', runtime, now)).toMatchObject({ allow: false });
  });

  it('keeps the owner allowed when the explicit allow list names other callers', () => {
    const cfg = config({ allow: [{ kind: 'number', value: '+61499999999' }] });
    const projected = projectPhoneContacts(cfg, [owner]);

    expect(decideInboundCall(owner.numbers[0]!, { ...cfg, contacts: projected }, [owner]))
      .toMatchObject({ allow: true, number: owner.numbers[0], contact: { role: 'owner' } });
  });

  it('keeps an explicit blocked contact rule stronger than the owner identity and allow list', () => {
    const cfg = resolvePhoneLineConfig({
      ...config({ allow: [{ kind: 'contact', value: owner.id }], unknownCallers: 'allow' }),
      contactRules: [{
        contactId: owner.id, role: 'blocked', callIn: false, callOut: false, smsIn: false, smsOut: false,
        conf: false, pin: '', messages: false,
      }],
    });

    expect(projectPhoneContacts(cfg, [owner])).toEqual([]);
    expect(decideInboundCall(owner.numbers[0]!, cfg, [owner])).toEqual({ allow: false, reason: 'blocked' });
  });

  it('applies the unknown-caller setting to callers missing from the address book', () => {
    const allowed = decideInboundCall('+61400000000', config({ unknownCallers: 'allow' }), contacts);
    const allowedOutsideLegacyAllowList = decideInboundCall('+61400000001', config({
      unknownCallers: 'allow', allow: [{ kind: 'number', value: '+61400000002' }],
    }), contacts);
    const screened = decideInboundCall('+61400000000', config({ unknownCallers: 'screen' }), contacts);
    const blocked = decideInboundCall('+61400000000', config({ unknownCallers: 'block' }), contacts);

    expect(allowed).toMatchObject({ allow: true, number: '+61400000000', contact: { label: 'Unknown caller' } });
    expect(allowedOutsideLegacyAllowList).toMatchObject({ allow: true, number: '+61400000001' });
    expect(screened).toEqual({ allow: false, reason: 'not listed' });
    expect(blocked).toEqual({ allow: false, reason: 'unknown caller is blocked' });
  });

  it('keeps explicit blocks stronger than unknown-caller allow and explicit allow rules stronger than unknown-caller block', () => {
    const blocked = decideInboundCall('+61400000000', config({ unknownCallers: 'allow', block: [{ kind: 'number', value: '+61400000000' }] }), contacts);
    const known = decideInboundCall('+61491570156', config({
      unknownCallers: 'block', allow: [{ kind: 'contact', value: 'maya' }],
    }), contacts);
    const explicitlyAllowedUnknown = decideInboundCall('+61400000003', config({
      unknownCallers: 'block', allow: [{ kind: 'number', value: '+61400000003' }],
    }), contacts);

    expect(blocked).toEqual({ allow: false, reason: 'blocked' });
    expect(known).toMatchObject({ allow: true, number: '+61491570156', contact: { label: 'Maya Chen' } });
    expect(explicitlyAllowedUnknown).toMatchObject({ allow: true, number: '+61400000003' });
  });

  it('applies unknown-caller handling to private numbers only after the private-number gate', () => {
    const allowed = decideInboundCall('Private', config({ acceptPrivate: true, unknownCallers: 'allow' }), contacts);
    const screened = decideInboundCall('Private', config({ acceptPrivate: true, unknownCallers: 'screen' }), contacts);
    const blocked = decideInboundCall('Private', config({ acceptPrivate: true, unknownCallers: 'block' }), contacts);
    const denied = decideInboundCall('Private', config({ acceptPrivate: false, unknownCallers: 'allow' }), contacts);

    expect(allowed).toMatchObject({ allow: true, contact: { label: 'Private caller' } });
    expect(screened).toEqual({ allow: false, reason: 'withheld or invalid number' });
    expect(blocked).toEqual({ allow: false, reason: 'private caller is blocked' });
    expect(denied).toEqual({ allow: false, reason: 'private caller is not allowed' });
  });

  it('projects migrated contact permissions through canonical address-book identities', () => {
    const cfg = resolvePhoneLineConfig({ contactRules: [{
      contactId: 'maya', role: 'owner', callIn: true, callOut: true, smsIn: true, smsOut: false,
      conf: true, pin: '246813', messages: true,
    }] });

    const projected = projectPhoneContacts(cfg, contacts);
    expect(projected).toContainEqual(expect.objectContaining({
      label: 'Maya Chen', pattern: '+61491570156', role: 'owner', pin: '', callOut: true,
    }));
    expect(JSON.stringify(projected)).not.toContain('246813');
  });

  it('accepts private callers only when configured, and keeps them out of the agent path', () => {
    const accepted = decideInboundCall('', config({ acceptPrivate: true }), contacts);
    const denied = decideInboundCall('', config({ acceptPrivate: false }), contacts);

    expect(accepted).toEqual({ allow: false, reason: 'withheld or invalid number' });
    expect(denied).toEqual({ allow: false, reason: 'private caller is not allowed' });
  });
});

describe('decideSpamAction', () => {
  const score = { score: 80, recentShortCalls: 0, spamVerdicts: 2, autoBlock: true };

  it('blocks after two spam verdicts even when the configured action is screen', () => {
    expect(decideSpamAction({ allow: false, reason: 'not listed' }, { threshold: 99, action: 'screen' }, score))
      .toEqual({ action: 'block', score: 80, autoBlock: true });
  });

  it('applies the configured threshold action to an unlisted caller', () => {
    expect(decideSpamAction({ allow: false, reason: 'not listed' }, { threshold: 60, action: 'screen' }, { ...score, autoBlock: false }))
      .toEqual({ action: 'screen', score: 80, autoBlock: false });
    expect(decideSpamAction({ allow: false, reason: 'not listed' }, { threshold: 90, action: 'block' }, { ...score, autoBlock: false }))
      .toBeNull();
  });

  it('leaves contact and owner allow decisions and explicit block rules untouched', () => {
    const allowed = decideInboundCall('+61491570156', config({ allow: [{ kind: 'contact', value: 'maya' }] }), contacts);
    const blocked = { allow: false, reason: 'blocked' } as const;

    expect(decideSpamAction(allowed, { threshold: 0, action: 'block' }, score)).toBeNull();
    expect(decideSpamAction(blocked, { threshold: 0, action: 'screen' }, score)).toBeNull();
    expect(decideSpamAction({ allow: false, reason: 'not on allow list' }, { threshold: 0, action: 'screen' }, score)).toBeNull();
  });
});

describe('resolveInboundHandling', () => {
  it('defaults SMS auto-replies off and follows contact, group, schedule, then default precedence', () => {
    const cfg = resolvePhoneLineConfig({
      schedule: { timeZone: 'Australia/Sydney', slots: [
        { days: [1], start: '09:00', end: '17:00', action: 'standard', smsAutoReply: { mode: 'fixed', text: 'Schedule reply' } },
      ] },
      inboundHandling: {
        default: { action: 'standard', smsAutoReply: { mode: 'agent' } },
        rules: [
          { kind: 'group', value: 'Work', action: 'standard', smsAutoReply: { mode: 'fixed', text: 'Group reply' } },
          { kind: 'contact', value: 'maya', action: 'standard', smsAutoReply: { mode: 'agent' } },
        ],
      },
    });
    const mondayDuringSchedule = new Date('2026-10-26T00:00:00Z');

    expect(resolveInboundHandling('+61491570156', cfg, contacts, mondayDuringSchedule).smsAutoReply.mode).toBe('agent');
    expect(resolveInboundHandling('+61280000101', cfg, contacts, mondayDuringSchedule).smsAutoReply)
      .toEqual({ mode: 'fixed', text: 'Group reply' });
    expect(resolveInboundHandling('+61400000000', cfg, contacts, mondayDuringSchedule).smsAutoReply)
      .toEqual({ mode: 'fixed', text: 'Schedule reply' });
    expect(resolveInboundHandling('+61400000000', cfg, contacts, new Date('2026-10-26T06:00:00Z')).smsAutoReply.mode)
      .toBe('agent');
    expect(resolvePhoneLineConfig({}).inboundHandling.default.smsAutoReply)
      .toEqual({ mode: 'none', text: '' });
  });

  it('resolves contact before group before default, and uses default for unknown callers', () => {
    const cfg = resolvePhoneLineConfig({ inboundHandling: {
      default: { action: 'message', greeting: 'Default greeting', instructions: 'Default note' },
      rules: [
        { kind: 'group', value: ' Work ', action: 'always-through', greeting: '', instructions: '' },
        { kind: 'contact', value: 'maya', action: 'block', greeting: '', instructions: '' },
      ],
    } });

    expect(resolveInboundHandling('+61491570156', cfg, contacts)).toMatchObject({ action: 'block' });
    expect(resolveInboundHandling('+61280000101', cfg, contacts)).toMatchObject({ action: 'always-through' });
    expect(resolveInboundHandling('+61400000000', cfg, contacts)).toMatchObject({ action: 'message', greeting: 'Default greeting' });
  });

  it('uses contact and group rules before the active slot, then falls back to the default', () => {
    const cfg = resolvePhoneLineConfig({
      schedule: { timeZone: 'Australia/Sydney', slots: [
        { days: [1], start: '09:00', end: '17:00', action: 'message', greeting: 'Scheduled greeting', instructions: '' },
      ] },
      inboundHandling: {
        default: { action: 'standard', greeting: 'Default greeting', instructions: '' },
        rules: [
          { kind: 'group', value: 'Work', action: 'always-through', greeting: '', instructions: '' },
          { kind: 'contact', value: 'maya', action: 'block', greeting: '', instructions: '' },
        ],
      },
    });
    const mondayDuringSchedule = new Date('2026-10-26T00:00:00Z');

    expect(resolveInboundHandling('+61491570156', cfg, contacts, mondayDuringSchedule).action).toBe('block');
    expect(resolveInboundHandling('+61280000101', cfg, contacts, mondayDuringSchedule).action).toBe('always-through');
    expect(resolveInboundHandling('+61400000000', cfg, contacts, mondayDuringSchedule)).toMatchObject({ action: 'message', greeting: 'Scheduled greeting' });
    expect(resolveInboundHandling('+61400000000', cfg, contacts, new Date('2026-10-26T06:00:00Z'))).toMatchObject({ action: 'standard', greeting: 'Default greeting' });
  });

  it('lets Busy and DND override schedule and default, while Normal follows schedule then default', () => {
    const base = {
      schedule: { timeZone: 'Australia/Sydney', slots: [
        { days: [1], start: '09:00', end: '17:00', action: 'always-through' as const, greeting: 'Scheduled', instructions: '' },
      ] },
      inboundHandling: {
        default: { action: 'standard' as const, greeting: 'Default', instructions: '' },
        rules: [],
      },
    };
    const mondayDuringSchedule = new Date('2026-10-26T00:00:00Z');
    const busy = resolvePhoneLineConfig({ ...base, inboundMode: 'busy' });
    const dnd = resolvePhoneLineConfig({ ...base, inboundMode: 'dnd' });
    const normal = resolvePhoneLineConfig({ ...base, inboundMode: 'normal' });

    expect(resolveInboundHandling('+61400000000', busy, contacts, mondayDuringSchedule)).toMatchObject({ action: 'message', greeting: 'Scheduled' });
    expect(resolveInboundHandling('+61400000000', dnd, contacts, mondayDuringSchedule)).toMatchObject({ action: 'block', greeting: 'Scheduled' });
    expect(resolveInboundHandling('+61400000000', normal, contacts, mondayDuringSchedule)).toMatchObject({ action: 'always-through', greeting: 'Scheduled' });
    expect(resolveInboundHandling('+61400000000', normal, contacts, new Date('2026-10-26T06:00:00Z'))).toMatchObject({ action: 'standard', greeting: 'Default' });
  });
});

describe('dialString', () => {
  it('prefixes #31# when a matching allow rule withholds caller ID', () => {
    expect(dialString('+61491570156', config({ allow: [{ kind: 'contact', value: 'maya', withhold: true }] }), contacts)).toBe('#31#+61491570156');
    expect(dialString('+61280000199', config({ allow: [{ kind: 'number', value: '+612800001*', withhold: true }] }), contacts)).toBe('#31#+61280000199');
  });

  it('applies a group rule to its members only', () => {
    const cfg = config({ allow: [{ kind: 'group', value: 'Family', withhold: true }] });
    expect(dialString('+61491570156', cfg, contacts)).toBe('#31#+61491570156');
    expect(dialString('+61280000101', cfg, contacts)).toBe('+61280000101');
  });

  it('dials the plain number when no rule withholds', () => {
    expect(dialString('+61491570156', config({ allow: [{ kind: 'contact', value: 'maya' }] }), contacts)).toBe('+61491570156');
    expect(dialString('+61400000000', config(), contacts)).toBe('+61400000000');
  });

  it('keeps withhold through config resolution', () => {
    expect(config({ allow: [{ kind: 'contact', value: 'maya', withhold: true }] }).screening.allow[0]).toMatchObject({ withhold: true });
  });
});
