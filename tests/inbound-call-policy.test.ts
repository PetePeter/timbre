import { describe, expect, it } from 'vitest';
import { decideInboundCall, projectPhoneContacts, type InboundRule } from '../src/phone/inbound-call-policy.js';
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

    expect(projectPhoneContacts(cfg, contacts)).toContainEqual(expect.objectContaining({
      label: 'Maya Chen', pattern: '+61491570156', role: 'owner', pin: '246813', callOut: true,
    }));
  });

  it('accepts private callers only when configured, and keeps them out of the agent path', () => {
    const accepted = decideInboundCall('', config({ acceptPrivate: true }), contacts);
    const denied = decideInboundCall('', config({ acceptPrivate: false }), contacts);

    expect(accepted).toEqual({ allow: false, reason: 'withheld or invalid number' });
    expect(denied).toEqual({ allow: false, reason: 'private caller is not allowed' });
  });
});
