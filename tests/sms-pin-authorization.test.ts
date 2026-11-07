import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiAgent, type ExternalToolProvider } from '../src/agents/api-agent.js';
import type { PhoneLine } from '../src/agents/phone-tools.js';
import type { ChatClient, ChatMessage, CompletionResult } from '../src/session/api/api-agent-loop.js';
import { ContactsStore } from '../src/contacts/contacts-store.js';
import { projectPhoneContacts } from '../src/phone/inbound-call-policy.js';
import { PhoneBridge } from '../src/phone/phone-bridge.js';
import { resolvePhoneLineConfig, type PhoneLineConfig } from '../src/phone/phone-config.js';
import { SmsAutoReplyCooldown } from '../src/phone/sms-auto-reply.js';
import { SmsPinLockout, stripSmsPin } from '../src/phone/sms-pin-auth.js';
import { handleMcp } from '../src/server/mcp.js';
import { createPhoneBridgeFixture } from './helpers/phone-bridge-fixture.js';
import { phoneActionSmsSender } from './helpers/phone-action-sms.js';

const OWNER = '+61491570156';
const OTHER = '+61491570157';
const PIN = '246813';
const PHONE_ID = 'sms-pin-phone';
const OPERATOR = PHONE_ID;

const cleanReply = (text: string): CompletionResult => ({ message: { content: text } });
const callTool = (name: string, args: Record<string, unknown>): CompletionResult => ({
  message: { content: null, tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
});

class ScriptedModel implements ChatClient {
  readonly seen: ChatMessage[][] = [];
  constructor(private readonly replies: CompletionResult[]) {}
  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.seen.push(structuredClone(messages));
    return this.replies.shift() ?? cleanReply('done');
  }
}

const until = async (pred: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function setup(opts: { pin?: string; replies: CompletionResult[]; externalTools?: ExternalToolProvider }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-sms-pin-'));
  const contacts = new ContactsStore(dir, PHONE_ID, '+61');
  const owner = await contacts.add({ name: 'Me', numbers: [OWNER], group: '', trusted: true, isUser: true });
  const other = await contacts.add({ name: 'Other', numbers: [OTHER], group: '', trusted: true, isUser: false });
  if (opts.pin) contacts.setPin(owner.id, opts.pin);

  const base = resolvePhoneLineConfig({
    enabled: true,
    countryCode: '+61',
    localNumber: '+61400000999',
    limits: { callsPerHour: 3, smsPerHour: 10, maxCallMin: 0, quietStart: '', quietEnd: '' },
    voice: { tts: '', piperModel: '', sapiVoice: '', sttModel: 'test-stt' },
    inboundHandling: {
      default: { action: 'standard', greeting: '', instructions: '', smsAutoReply: { mode: 'none', text: '' } },
      rules: [{ kind: 'contact', value: owner.id, action: 'standard', greeting: '', instructions: '', smsAutoReply: { mode: 'agent', text: '' } }],
    },
  });
  let cfg: PhoneLineConfig = { ...base, contacts: projectPhoneContacts(base, contacts.list()) };
  cfg = {
    ...cfg,
    contactRules: [...cfg.contactRules, {
      contactId: other.id, role: 'trusted', callIn: true, callOut: false, smsIn: true, smsOut: true, conf: false, pin: '', messages: false,
    }],
    inboundHandling: {
      ...cfg.inboundHandling,
      rules: [...cfg.inboundHandling.rules, {
        kind: 'contact', value: other.id, action: 'standard', greeting: '', instructions: '', smsAutoReply: { mode: 'agent', text: '' },
      }],
    },
  };
  cfg = { ...cfg, contacts: projectPhoneContacts(cfg, contacts.list()) };
  const delivered: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const smsBodies = new Map<string, { number: string; text: string }>();
  const model = new ScriptedModel(opts.replies);
  let bridge!: PhoneBridge;
  const line = {
    sendToSession: (message: Parameters<PhoneLine['sendToSession']>[0]) => bridge.sendToSession(message),
    hangup: (sessionId: string) => bridge.hangup(sessionId),
    inbox: () => bridge.inbox(),
    hasContact: (name: string) => bridge.hasContact(name),
    sendSmsToContact: (sessionId: string, name: string, text: string, authorization?: Parameters<NonNullable<PhoneLine['sendSmsToContact']>>[3]) =>
      bridge.sendSmsToContact(sessionId, name, text, authorization),
    startCallAgent: (sessionId: string, request: Parameters<PhoneLine['startCallAgent']>[1], smsInteractionId?: string) =>
      bridge.startCallAgent(sessionId, request, smsInteractionId),
    transfer: (from: string, to: string, text: string) => bridge.transfer(from, to, text),
    enterMessageMode: (sessionId: string) => bridge.enterMessageMode(sessionId),
    reportCallOutcome: (sessionId: string, interactionId: string, outcome: Parameters<PhoneLine['reportCallOutcome']>[2]) =>
      bridge.reportCallOutcome(sessionId, interactionId, outcome),
    verifyCaller: (sessionId: string) => bridge.verifyCaller(sessionId),
    isCallerVerified: (sessionId: string) => bridge.isCallerVerified(sessionId),
    authorizeSmsAction: (sessionId: string, interactionId: string, consumeMcpAction?: boolean) =>
      bridge.authorizeSmsAction(sessionId, interactionId, consumeMcpAction),
    authorizeSmsReply: (sessionId: string, sourceInteractionId: string, replyInteractionId: string, consumeMcpAction?: boolean) =>
      bridge.authorizeSmsReply(sessionId, sourceInteractionId, replyInteractionId, consumeMcpAction),
    refuseSmsAction: (sessionId: string, interactionId: string, refusal?: string) => bridge.refuseSmsAction(sessionId, interactionId, refusal),
    recordAgentToolCall: () => {},
  } as unknown as PhoneLine;
  const agent = new ApiAgent({ client: model, line, sessionId: OPERATOR, name: 'Timbre', externalTools: opts.externalTools });
  const fixture = await createPhoneBridgeFixture({
    clientOptions: { clientVersion: 'test', heartbeatS: 1, baseDelayMs: 10 },
    configureServer: (server) => {
      server.handlers.set('call.dial', () => ({ callId: 'sms-call-1' }));
      server.handlers.set('sms.read', (params) => smsBodies.get(String(params.handle)) ?? { number: OWNER, text: '', ts: '' });
    },
    bridge: {
      phoneId: PHONE_ID,
      getConfig: () => cfg,
      getOperatorId: () => OPERATOR,
      sessionName: () => 'Timbre',
      deliver: async (_sessionId, text, context) => { delivered.push(text); await agent.deliver(text, context); },
      defaultTranscriptDir: path.join(dir, 'transcripts'),
      recordingsDir: path.join(dir, 'recordings'),
      smsPollMs: 0,
      smsMemory: { seen: new Set(), received: new Set(), primed: true, autoReplyCooldown: new SmsAutoReplyCooldown(0) },
      callAgentModel: () => ({ async complete() { return cleanReply('call completed'); } }),
      lookupAddressBook: (number) => number ? contacts.findByNumber(number) : contacts.list(),
      hasCallerPin: (contactId) => contacts.hasPin(contactId),
      verifyCallerPin: (contactId, pin) => contacts.verifyPin(contactId, pin),
      sendSmsAction: phoneActionSmsSender(() => bridge, PHONE_ID, () => cfg),
      recordEvent: (event) => events.push(event as unknown as Record<string, unknown>),
      log: (message) => logs.push(message),
    },
  });
  bridge = fixture.bridge;
  const phap = fixture.server;
  const client = fixture.client;
  cleanup.push(() => agent.stop(), () => fixture.close(), () => rmSync(dir, { recursive: true, force: true }));

  return {
    phap, client, bridge, agent, model, line, delivered, events, logs,
    async receive(handle: string, text: string, number = OWNER) {
      const modelCalls = model.seen.length;
      smsBodies.set(handle, { number, text });
      phap.emit('sms.received', { handle, number, preview: text });
      await until(() => model.seen.length > modelCalls);
      await agent.idle();
    },
    setConfig(value: PhoneLineConfig) { cfg = value; },
  };
}

describe('PIN authorization for SMS initiated actions', () => {
  it('escalates lockout duration after repeated batches of wrong PINs', () => {
    const lockout = new SmsPinLockout(3, 1_000);
    const contactId = 'contact-1';
    const failThreeTimes = (at: number) => {
      expect(lockout.recordFailure(contactId, at)).toBe(false);
      expect(lockout.recordFailure(contactId, at + 1)).toBe(false);
      expect(lockout.recordFailure(contactId, at + 2)).toBe(true);
    };

    failThreeTimes(100);
    expect(lockout.isLocked(contactId, 1_099)).toBe(true);
    expect(lockout.isLocked(contactId, 1_102)).toBe(false);
    failThreeTimes(1_102);
    expect(lockout.isLocked(contactId, 3_103)).toBe(true);
    expect(lockout.isLocked(contactId, 3_104)).toBe(false);
    lockout.reset(contactId);
    expect(lockout.isLocked(contactId, 10_000)).toBe(false);
  });

  it('refuses a privileged action with a clear reply when the contact has no PIN', async () => {
    const { phap, receive } = await setup({ replies: [callTool('phone_call_agent', { to: 'Me', task: 'Call me back' }), cleanReply('done')] });

    await receive('no-pin', 'Please call me back.');

    expect(phap.requests.some((request) => request.method === 'call.dial')).toBe(false);
    const refusal = phap.requests.find((request) => request.method === 'sms.send')?.params;
    expect(refusal).toMatchObject({ number: OWNER });
    expect(refusal?.text).toMatch(/no PIN is configured/i);
  });

  it('rejects wrong PINs, locks the contact after three failures, and keeps the PIN out of model and logs', async () => {
    const replies = Array.from({ length: 4 }, () => [
      callTool('phone_call_agent', { to: 'Me', task: 'Call me back' }), cleanReply('done'),
    ]).flat();
    const { phap, receive, model, events, logs } = await setup({ pin: PIN, replies });

    await receive('wrong-1', 'Please call me back. PIN: 111111');
    await receive('wrong-2', 'Please call me back. PIN: 111111');
    await receive('wrong-3', 'Please call me back. PIN: 111111');
    await receive('locked-correct', `Please call me back. PIN: ${PIN}`);

    expect(phap.requests.some((request) => request.method === 'call.dial')).toBe(false);
    expect(phap.requests.filter((request) => request.method === 'sms.send')).toHaveLength(4);
    expect(phap.requests.filter((request) => request.method === 'sms.send').at(-1)?.params.text).toMatch(/locked/i);
    expect(JSON.stringify(model.seen)).not.toContain(PIN);
    expect(JSON.stringify(events)).not.toContain(PIN);
    expect(logs.join('\n')).not.toContain(PIN);
  });

  it('allows a call agent when the same SMS includes the correct contact PIN without exposing it', async () => {
    const { phap, receive, model, events, logs } = await setup({
      pin: PIN,
      replies: [callTool('phone_call_agent', { to: 'Me', task: 'Call me back' }), cleanReply('done')],
    });

    await receive('correct-pin', `Please call me back. PIN ${PIN}`);
    await until(() => phap.requests.some((request) => request.method === 'call.dial'));

    expect(phap.requests.find((request) => request.method === 'call.dial')?.params.number).toBe(OWNER);
    expect(JSON.stringify(model.seen)).not.toContain(PIN);
    expect(JSON.stringify(events)).not.toContain(PIN);
    expect(logs.join('\n')).not.toContain(PIN);
  });

  it('keeps ordinary SMS chat and a reply to that sender available without a PIN', async () => {
    const { phap, receive, model } = await setup({
      replies: [callTool('chat_send', { text: 'Hello, how can I help?' }), cleanReply('done')],
    });

    await receive('plain-chat', 'Hi there, can you help?');

    expect(phap.requests.find((request) => request.method === 'sms.send')?.params)
      .toEqual({ number: OWNER, text: 'Hello, how can I help?' });
    expect(phap.requests.some((request) => request.method === 'call.dial')).toBe(false);
    expect(JSON.stringify(model.seen)).toContain('Hi there, can you help?');
  });

  it('allows a reply to the current SMS sender through the phone MCP without a PIN', async () => {
    const { phap, line, receive } = await setup({ replies: [cleanReply('done')] });
    await receive('mcp-plain-chat', 'Hi there.');

    const response = await handleMcp({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'chat_send', arguments: { text: 'Hello back', interactionId: 'sms:mcp-plain-chat' } },
    }, line, PHONE_ID);

    expect(JSON.stringify(response)).toContain('sent');
    expect(phap.requests.find((request) => request.method === 'sms.send')?.params)
      .toMatchObject({ number: OWNER, text: 'Hello back' });
  });

  it('allows sending a reply to another sender only when the source SMS includes the correct PIN', async () => {
    const { phap, receive } = await setup({
      pin: PIN,
      replies: [
        cleanReply('done'), cleanReply('done'),
        callTool('chat_send', { text: 'Here is the information you asked for.', interactionId: 'sms:target-other' }), cleanReply('done'),
      ],
    });
    await receive('source-owner', 'Can you send this to the other person?', OWNER);
    await receive('target-other', 'Please send me the details.', OTHER);
    await receive('source-owner-authorized', `Send them the details. PIN: ${PIN}`, OWNER);

    const sent = phap.requests.filter((request) => request.method === 'sms.send');
    expect(sent).toHaveLength(1);
    expect(phap.requests.find((request) => request.method === 'sms.send')?.params)
      .toMatchObject({ number: OTHER, text: 'Here is the information you asked for.' });
  });

  it('does not let an SMS turn redirect a no-PIN chat reply to another sender', async () => {
    const { phap, line, receive } = await setup({ replies: [cleanReply('done'), cleanReply('done')] });
    await receive('source-owner', 'Please help me.', OWNER);
    await receive('latest-other', 'Hello there.', OTHER);

    const response = await handleMcp({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'chat_send', arguments: { text: 'Private response', interactionId: 'sms:source-owner' } },
    }, line, PHONE_ID);

    expect(JSON.stringify(response)).toMatch(/no PIN is configured/i);
    const sent = phap.requests.filter((request) => request.method === 'sms.send');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toMatchObject({ number: OTHER });
    expect(sent[0]?.params.text).toMatch(/no PIN is configured/i);
  });

  it('does not let a newer SMS action reuse an older message PIN through MCP', async () => {
    const { phap, line, receive } = await setup({ pin: PIN, replies: [cleanReply('done'), cleanReply('done')] });
    await receive('old-authorized', `Call me back. PIN: ${PIN}`, OWNER);
    await receive('current-unverified', 'Please do something.', OTHER);

    const response = await handleMcp({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'phone_call_agent', arguments: { to: 'Me', task: 'Call me back', smsInteractionId: 'sms:old-authorized' } },
    }, line, PHONE_ID);

    expect(JSON.stringify(response)).toMatch(/multiple SMS conversations/i);
    expect(phap.requests.some((request) => request.method === 'call.dial')).toBe(false);
    const refusal = phap.requests.find((request) => request.method === 'sms.send')?.params;
    expect(refusal).toMatchObject({ number: OTHER });
    expect(refusal?.text).toMatch(/multiple SMS conversations/i);
  });

  it('refuses an API-agent cross-sender reply when its source SMS has no PIN', async () => {
    const { phap, receive } = await setup({
      replies: [
        cleanReply('done'), cleanReply('done'),
        callTool('chat_send', { text: 'Here are the details.', interactionId: 'sms:target-other' }), cleanReply('done'),
      ],
    });
    await receive('api-source-owner', 'Can you send this to someone else?', OWNER);
    await receive('api-target-other', 'Please send me the details.', OTHER);
    await receive('api-source-owner-action', 'Send them the details.', OWNER);

    const sent = phap.requests.filter((request) => request.method === 'sms.send');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toMatchObject({ number: OWNER });
    expect(sent[0]?.params.text).toMatch(/no PIN is configured/i);
  });

  it('also refuses external MCP tools from an SMS turn without its PIN', async () => {
    const calls: string[] = [];
    const externalTools: ExternalToolProvider = {
      async listTools() { return [{ name: 'calendar_create', description: 'Create a calendar event', parameters: { type: 'object', properties: {} } }]; },
      async callTool(name) { calls.push(name); return 'created'; },
      async close() {},
    };
    const { phap, receive } = await setup({
      externalTools,
      replies: [callTool('calendar_create', {}), cleanReply('done')],
    });

    await receive('external-no-pin', 'Book a meeting for tomorrow.');

    expect(calls).toEqual([]);
    expect(phap.requests.find((request) => request.method === 'sms.send')?.params.text).toMatch(/no PIN is configured/i);
  });

  it('enforces the contact PIN again at the phone MCP tool boundary', async () => {
    const { phap, line, receive } = await setup({ pin: PIN, replies: [cleanReply('done')] });
    await receive('mcp-authorized', `Call me back. PIN ${PIN}`);

    const response = await handleMcp({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'phone_call_agent', arguments: { to: 'Me', task: 'Call me back', smsInteractionId: 'sms:mcp-authorized' } },
    }, line, PHONE_ID);
    await until(() => phap.requests.some((request) => request.method === 'call.dial'));

    expect(JSON.stringify(response)).toContain('dialing');
    expect(phap.requests.some((request) => request.method === 'sms.send')).toBe(false);
  });

  it('does not carry an authorized SMS into a later unverified live-call turn', async () => {
    const { phap, line, receive, model } = await setup({
      pin: PIN,
      replies: [cleanReply('done')],
    });
    await receive('old-authorized', `Please call me. PIN: ${PIN}`);

    const turnsBeforeCall = model.seen.length;
    phap.emit('call.ringing', { callId: 'unverified-call', number: OWNER, allowed: true });
    await phap.waitFor('call.answer');
    phap.emit('call.state', { callId: 'unverified-call', state: 'active' });
    await until(() => phap.requests.some((request) => request.method === 'call.say'
      && request.params.text === 'Please enter your caller PIN on the keypad or say the digits.'));

    const response = await handleMcp({
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'phone_call_agent', arguments: { to: 'Me', task: 'Call me back', smsInteractionId: 'sms:old-authorized' } },
    }, line, PHONE_ID);

    expect(phap.requests.some((request) => request.method === 'call.dial')).toBe(false);
    expect(JSON.stringify(response)).toMatch(/PIN|authorization|verification/i);
    expect(model.seen).toHaveLength(turnsBeforeCall);
  });

  it('keeps a known no-PIN caller in Timbre message mode after a pending SMS', async () => {
    const { phap, receive, model } = await setup({ replies: [cleanReply('done')] });
    await receive('no-pin-before-call', 'Hello, can you help?');

    const turnsBeforeCall = model.seen.length;
    phap.emit('call.ringing', { callId: 'hangup-call', number: OWNER, allowed: true });
    await phap.waitFor('call.answer');
    phap.emit('call.state', { callId: 'hangup-call', state: 'active' });
    await until(() => phap.requests.some((request) => request.method === 'call.say'
      && request.params.text === 'Please leave a message after this and I will pass it on.'));

    expect(model.seen).toHaveLength(turnsBeforeCall);
    expect(phap.requests.some((request) => request.method === 'call.say' && /anything else/.test(String(request.params.text)))).toBe(false);
  });

  it('allows only one privileged MCP action for a PIN SMS', async () => {
    const { phap, line, receive } = await setup({ pin: PIN, replies: [cleanReply('done')] });
    await receive('mcp-one-shot', `Open my inbox. PIN ${PIN}`);

    const request = (id: number, name: string, args: Record<string, unknown>) => handleMcp({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
    }, line, PHONE_ID);
    const first = await request(5, 'phone_inbox', { smsInteractionId: 'sms:mcp-one-shot' });
    const replay = await request(6, 'phone_call_agent', {
      to: 'Me', task: 'Call me back', smsInteractionId: 'sms:mcp-one-shot',
    });

    expect(JSON.stringify(first)).toContain('messages');
    expect(JSON.stringify(replay)).toMatch(/already used/i);
    expect(phap.requests.some((request) => request.method === 'call.dial')).toBe(false);
  });

  it('does not leave a PIN capability after a plain MCP reply', async () => {
    const { phap, line, receive } = await setup({ pin: PIN, replies: [cleanReply('done')] });
    await receive('mcp-reply-consumes', `Hi. PIN ${PIN}`);

    const reply = await handleMcp({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'chat_send', arguments: { text: 'Hello back', interactionId: 'sms:mcp-reply-consumes' } },
    }, line, PHONE_ID);
    const replay = await handleMcp({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'phone_inbox', arguments: { smsInteractionId: 'sms:mcp-reply-consumes' } },
    }, line, PHONE_ID);

    expect(JSON.stringify(reply)).toContain('sent');
    expect(JSON.stringify(replay)).toMatch(/already used/i);
    const sent = phap.requests.filter((request) => request.method === 'sms.send');
    expect(sent).toHaveLength(2);
    expect(sent[0]?.params.text).toBe('Hello back');
    expect(sent[1]?.params.text).toMatch(/already used/i);
  });

  it.each([
    'PIN: 12 34',
    'PIN-1234',
    'PIN1234',
    'PIN is 1234',
  ])('strips labelled PIN variants before delivery: %s', (input) => {
    const stripped = stripSmsPin(`Call me. ${input}`);
    expect(stripped).toEqual({ text: 'Call me.', supplied: true, pin: '1234' });
    expect(stripped.text).not.toContain('1234');
  });
});
