import { describe, expect, it } from 'vitest';
import { decideInboundCall, decideSpamAction, projectPhoneContacts, resolveInboundHandling, type InboundRule } from '../src/phone/inbound-call-policy.js';
import { resolvePhoneLineConfig } from '../src/phone/phone-config.js';
import type { AddressBookContact } from '../src/contacts/contact.js';

const contacts: AddressBookContact[] = [
  { id: 'maya', name: 'Maya Chen', numbers: ['+61491570156'], group: 'Family', trusted: true, isUser: false },
  { id: 'alex', name: 'Alex Morgan', numbers: ['+61280000101'], group: 'Work', trusted: false, isUser: false },
];

function config(screening: Partial<{ allow: InboundRule[]; block: InboundRule[]; acceptPrivate: boolean }> = {}) {
  return resolvePhoneLineConfig({
    screening: { allow: [], block: [], acceptPrivate: true, ...screening },
  });
}

describe('decideInboundCall', () => {
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
    expect(unknown).toEqual({ allow: false, reason: 'not on allow list' });
  });

  it('keeps unknown callers on the code-only Reception path when no allow list is configured', () => {
    expect(decideInboundCall('+61400000000', config(), contacts)).toEqual({ allow: false, reason: 'not listed' });
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
});
