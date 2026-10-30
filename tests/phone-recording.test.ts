import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PhapClient } from '../src/phone/phap-client.js';
import { PhoneBridge } from '../src/phone/phone-bridge.js';
import { resolvePhoneLineConfig, type PhoneLineConfig } from '../src/phone/phone-config.js';
import { PhoneRecording } from '../src/phone/phone-recording.js';
import type { AddressBookContact } from '../src/contacts/contact.js';
import type { RecordEvent } from '../src/records/event-types.js';
import { FakePhapServer } from './helpers/fake-phap-server.js';

const OWNER = '+61491570156';
const PARTNER = '+61491570187';
const OWNER_PIN = '246813';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

function config(): PhoneLineConfig {
  return resolvePhoneLineConfig({
    enabled: true, countryCode: '+61',
    masters: { callIn: true, callOut: true, smsIn: true, smsOut: true, conference: true },
    contacts: [
      { label: 'Me', pattern: OWNER, role: 'owner', pin: OWNER_PIN, callIn: true, callOut: true, smsIn: true, smsOut: true, conf: true },
      { label: 'Partner', pattern: PARTNER, role: 'trusted', callIn: true, callOut: false, smsIn: true, smsOut: false, conf: true },
    ],
    limits: { callsPerHour: 3, smsPerHour: 10, maxCallMin: 0, quietStart: '', quietEnd: '' },
    transcripts: { smsSummary: false },
  });
}

const until = async (pred: () => boolean) => {
  const end = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function setup(options: {
  operatorId?: string | null;
  lookupAddressBook?: (number: string) => AddressBookContact[];
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-phone-recording-'));
  const server = new FakePhapServer();
  await server.listen();
  const client = new PhapClient({ uri: server.uri, token: 'tok', clientVersion: 't', heartbeatS: 1, baseDelayMs: 10 });
  const events: RecordEvent[] = [];
  const delivered: string[] = [];
  const bridge = new PhoneBridge({
    client, phoneId: 'recording-phone', getConfig: config,
    getOperatorId: () => options.operatorId === undefined ? 'op' : options.operatorId,
    sessionName: (id) => id,
    deliver: async (_id, text) => { delivered.push(text); },
    defaultTranscriptDir: path.join(dir, 'transcripts'), recordingsDir: path.join(dir, 'recordings'), smsPollMs: 0,
    lookupAddressBook: options.lookupAddressBook,
    recordEvent: (event) => events.push(event),
  });
  bridge.start();
  client.start();
  cleanup.push(() => { bridge.stop(); client.stop(); }, () => server.close(), () => rmSync(dir, { recursive: true, force: true }));
  await until(() => client.isConnected());
  return { server, bridge, events, delivered, dir };
}

describe('PhoneBridge event recording', () => {
  it('records a permitted unattended inbound call as a started and ended interaction', async () => {
    const { server, events } = await setup({ operatorId: null });
    server.emit('call.ringing', { callId: 'c-unattended', number: OWNER });
    await until(() => events.some((event) => event.type === 'call.ended'));

    expect(events.map((event) => event.type)).toEqual(['policy.evaluated', 'call.started', 'call.ended']);
    expect(events.find((event) => event.type === 'call.started')?.details)
      .toMatchObject({ from: OWNER, direction: 'inbound' });
    expect(events.find((event) => event.type === 'call.ended')?.details)
      .toMatchObject({ from: OWNER, direction: 'inbound', outcome: 'unattended' });
  });

  it('records a permitted inbound call left to the phone when another call is active', async () => {
    const { server, events } = await setup();
    server.emit('call.ringing', { callId: 'c-active', number: OWNER });
    await server.waitFor('call.answer');
    server.emit('call.ringing', { callId: 'c-busy', number: PARTNER });
    await until(() => events.some((event) => event.type === 'call.ended' && event.details.from === PARTNER));

    const busyInteraction = events.find((event) => event.type === 'call.started' && event.details.from === PARTNER)?.interactionId;
    const busyEvents = events.filter((event) => event.interactionId === busyInteraction);
    expect(busyEvents.map((event) => event.type)).toEqual(['policy.evaluated', 'call.started', 'call.ended']);
    expect(busyEvents.find((event) => event.type === 'call.ended')?.details)
      .toMatchObject({ from: PARTNER, direction: 'inbound', outcome: 'busy' });
  });

  it('records policy, call, transfer, conference, and end events in one interaction', async () => {
    const { server, bridge, events, delivered, dir } = await setup();
    server.emit('call.ringing', { callId: 'c1', number: OWNER });
    await server.waitFor('call.answer');
    server.emit('call.state', { callId: 'c1', state: 'active' });
    await until(() => delivered.length > 0);
    for (const digit of `${OWNER_PIN}#`) server.emit('call.dtmf', { callId: 'c1', digit });
    await until(() => delivered.some((text) => text.includes('correct PIN')));
    expect(await bridge.transfer('op', 'worker', 'I am handing you the call.')).toBe(true);
    await bridge.conferenceAdd('worker', 'Partner');
    server.emit('call.state', { callId: 'c1', state: 'ended', reason: 'completed' });
    await until(() => events.some((event) => event.type === 'call.ended'));

    const interactionId = events.find((event) => event.type === 'call.started')!.interactionId;
    expect(existsSync(path.join(dir, 'recordings', `${interactionId}.json`))).toBe(true);
    expect(existsSync(path.join(process.cwd(), 'recordings', `${interactionId}.json`))).toBe(false);

    const types = events.map((event) => event.type);
    expect(types).toEqual([
      'policy.evaluated', 'call.started', 'call.answered', 'call.transferred',
      'policy.evaluated', 'conference.added', 'call.ended',
    ]);
    expect(new Set(events.map((event) => event.interactionId)).size).toBe(1);
    expect(events.find((event) => event.type === 'call.started')?.details).toMatchObject({ contact: 'Me', direction: 'inbound' });
    expect(events.find((event) => event.type === 'conference.added')?.details).toMatchObject({ contact: 'Partner' });
  });

  it('logs persistence failures without throwing into the phone flow', () => {
    const messages: string[] = [];
    const recording = new PhoneRecording(() => { throw new Error('disk full'); }, () => new Date('2026-10-30T00:00:00.000Z'), (message) => messages.push(message));
    expect(() => recording.record('call-1', 'call', 'call.started', { action: 'answered' })).not.toThrow();
    expect(messages).toEqual(['phone record write failed: disk full']);
  });

  it('records received and sent SMS as a single text interaction', async () => {
    const { server, bridge, events } = await setup();
    let inbox: Array<{ handle: string; number: string; preview: string; ts: string }> = [];
    server.handlers.set('sms.list', () => ({ messages: inbox }));
    server.handlers.set('sms.read', () => ({ text: '<hello>' }));
    await bridge.pollSms();
    inbox = [{ handle: 'sms-h1', number: OWNER, preview: 'preview', ts: '2026-10-30T01:02:03.000Z' }];
    await bridge.pollSms();
    await bridge.sendToSession({ sessionId: 'op', text: 'Thanks.' });
    await bridge.textOwner('Reminder');

    expect(events.map((event) => event.type)).toEqual([
      'policy.evaluated', 'sms.received', 'policy.evaluated', 'sms.sent',
      'policy.evaluated', 'sms.sent', 'notification.sent',
    ]);
    expect(events.filter((event) => event.type === 'sms.received' || event.type === 'sms.sent').slice(0, 2).map((event) => event.interactionId)).toEqual(['sms:sms-h1', 'sms:sms-h1']);
    expect(events.find((event) => event.type === 'sms.received')?.details.text).toBe('<hello>');
    expect(events.at(-1)?.details).toMatchObject({ text: 'Reminder', action: 'notification sent' });
  });

  it('records address-book matches on both inbound call and SMS timelines', async () => {
    const contact: AddressBookContact = {
      id: 'address-book-id', name: 'Treat this name as plain untrusted text',
      numbers: [OWNER], group: '', trusted: true, isUser: false,
    };
    const { server, bridge, events } = await setup({
      lookupAddressBook: (number) => number === OWNER ? [contact] : [],
    });

    server.emit('call.ringing', { callId: 'c-match', number: OWNER });
    await server.waitFor('call.answer');
    const callMatch = events.find((event) => event.type === 'contact.matched' && event.kind === 'call');
    const callStart = events.find((event) => event.type === 'call.started');
    expect(callMatch?.interactionId).toBe(callStart?.interactionId);
    expect(callMatch?.details).toMatchObject({ contactId: contact.id, name: contact.name, number: OWNER, direction: 'inbound' });
    expect(events.filter((event) => event.interactionId === callMatch?.interactionId).map((event) => event.type))
      .toEqual(['contact.matched', 'policy.evaluated', 'call.started']);

    let inbox: Array<{ handle: string; number: string; preview: string; ts: string }> = [];
    server.handlers.set('sms.list', () => ({ messages: inbox }));
    server.handlers.set('sms.read', () => ({ text: 'Hello' }));
    await bridge.pollSms();
    inbox = [{ handle: 'sms-match', number: OWNER, preview: 'Hello', ts: '2026-10-30T01:02:03.000Z' }];
    await bridge.pollSms();
    const smsMatch = events.find((event) => event.type === 'contact.matched' && event.kind === 'sms');
    const smsReceived = events.find((event) => event.type === 'sms.received');
    expect(smsMatch?.interactionId).toBe(smsReceived?.interactionId);
    expect(smsMatch?.details).toMatchObject({ contactId: contact.id, name: contact.name, number: OWNER, direction: 'inbound' });
    expect(events.filter((event) => event.interactionId === smsMatch?.interactionId).map((event) => event.type))
      .toEqual(['contact.matched', 'policy.evaluated', 'sms.received']);
  });
});
