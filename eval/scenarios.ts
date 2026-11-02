/** Phone-call scenarios: a scripted far end plus pass/fail checks on what the agent did. */
import type { RunResult, Scenario } from './harness.js';

const STRANGER = '+61491570199';
const RECEPTION = '+61491570180';
const used = (r: RunResult, tool: string) => r.tools.some((t) => t.name === tool);
const outcome = (r: RunResult, value: string) => r.tools.some((t) => t.name === 'report_call_outcome' && t.args.outcome === value);
const anySaid = (r: RunResult, pattern: RegExp) => r.said.some((s) => pattern.test(s));
const conferenced = (r: RunResult) => r.methods.includes('conference.create');
const noErrors = { name: 'no agent errors', pass: (r: RunResult) => r.errors.length === 0 };

const HOLD_LINES = [
  'Thank you for calling PowerGrid Energy. Your call is important to us. Please stay on the line.',
  'Are you lonely tonight? Do you miss me tonight?',
  'Can you hear me calling, calling out your name?',
  'Your estimated wait time is 58 minutes.',
  'Hold me closer, tiny dancer, count the headlights on the highway.',
  'Did you know you can pay your bill online at powergrid dot com dot au?',
  'Is this the real life? Is this just fantasy?',
  'Your call is important to us. Please continue to hold.',
  'Hello, is it me you are looking for?',
  'Your estimated wait time is 31 minutes.',
  'And I will always love you, I will always love you.',
  'Thank you for your patience. A consultant will be with you shortly.',
];

export const SCENARIOS: Scenario[] = [
  {
    id: 'outbound-person',
    title: 'Call a normal person with a message',
    direction: 'outbound',
    to: '+61491570170',
    task: 'Call Agnes. Tell her dinner on Friday has moved from 6pm to 7pm and check she can still make it.',
    async play(far) {
      far.speak('Hello, Agnes speaking.');
      await far.reply(90_000);
      far.speak('Oh, seven instead of six? Yes, seven is fine. Tell Oscar I will be there.');
      await far.reply(60_000);
      if (!far.ended) far.speak('Okay, thanks, bye!');
      await far.sawMethod('call.hangup', 30_000);
    },
    checks: [
      { name: 'mentions 7pm', pass: (r) => anySaid(r, /\b(7|seven)(\s?pm)?\b/i) },
      { name: 'ends the call with hang_up', pass: (r) => used(r, 'hang_up') },
      { name: 'summary says she can make it', pass: (r) => r.tools.some((t) => t.name === 'hang_up' && /\b(yes|confirm|can make|fine|will be there|ok)/i.test(String(t.args.summary))) },
      { name: 'no keypad presses', pass: (r) => r.keys === '' },
      { name: 'does not ring the owner', pass: (r) => !conferenced(r) },
      noErrors,
    ],
  },
  {
    id: 'inbound-stranger-message',
    title: 'Stranger calls and leaves a message',
    direction: 'inbound',
    caller: STRANGER,
    async play(far) {
      await far.reply(60_000);
      far.speak('Hi, this is Mark from Smith Plumbing. Is Oscar there?');
      await far.reply(60_000);
      far.speak('Yes please. Tell him the part for his hot water system has arrived and we can fit it Thursday morning. My number is 0412 555 019.');
      await far.reply(60_000);
      far.speak('Great, thanks. Bye.');
      await far.sawMethod('call.hangup', 30_000);
    },
    checks: [
      { name: 'greets the caller', pass: (r) => r.said.length > 0 },
      { name: 'records left_message', pass: (r) => outcome(r, 'left_message') },
      { name: 'acknowledges the message', pass: (r) => r.said.length >= 2 },
      { name: 'does not transfer unasked', pass: (r) => !conferenced(r) },
      { name: 'hangs up', pass: (r) => used(r, 'phone_hangup') },
      noErrors,
    ],
  },
  {
    id: 'inbound-stranger-transfer',
    title: 'Stranger asks to be put through',
    direction: 'inbound',
    caller: STRANGER,
    addressBook: [{ id: 'reception-id', name: 'Reception', numbers: [RECEPTION], group: 'Work', trusted: false, isUser: false, transferTarget: true, defaultTransfer: true }],
    async play(far) {
      await far.reply(60_000);
      far.speak('Hi, I need to speak to someone about an urgent delivery. Can you put me through to a person please?');
      await far.sawMethod('conference.create', 90_000);
    },
    checks: [
      { name: 'transfers with transfer_to_contact', pass: (r) => used(r, 'transfer_to_contact') },
      { name: 'conference created', pass: (r) => conferenced(r) },
      { name: 'does not record a message instead', pass: (r) => !outcome(r, 'left_message') },
      noErrors,
    ],
  },
  {
    id: 'inbound-silent',
    title: 'Caller never says anything',
    direction: 'inbound',
    caller: STRANGER,
    async play(far) {
      await far.reply(60_000);
      await far.pause(20_000);
    },
    checks: [
      { name: 'greets', pass: (r) => r.said.length > 0 },
      { name: 'does not invent a message', pass: (r) => !outcome(r, 'left_message') },
      { name: 'does not transfer', pass: (r) => !conferenced(r) },
      { name: 'does not talk on and on (max 3 lines)', pass: (r) => r.said.length <= 3 },
      noErrors,
    ],
  },
  {
    id: 'inbound-cut-off',
    title: 'Call cut off mid-message',
    direction: 'inbound',
    caller: STRANGER,
    async play(far) {
      await far.reply(60_000);
      far.speak('Hi, it is Julia from the dentist, I am calling to move Oscar\'s appointment to');
      await far.pause(300);
      far.hangUp('remote');
      await far.pause(15_000);
    },
    checks: [
      { name: 'nothing said after the hang-up', pass: (r) => {
        const at = r.transcript.findIndex((e) => e.speaker === 'event' && e.text.startsWith('far end hung up'));
        return at >= 0 && !r.transcript.slice(at).some((e) => e.speaker === 'agent');
      } },
      { name: 'reports the outcome at most once', pass: (r) => r.tools.filter((t) => t.name === 'report_call_outcome').length <= 1 },
      { name: 'does not try to transfer', pass: (r) => !conferenced(r) },
      noErrors,
    ],
  },
  {
    id: 'outbound-ivr-hold',
    title: 'Business: keypad menu, an hour of hold music with lyrics, then a human',
    direction: 'outbound',
    to: '+61291234567',
    task: 'Call PowerGrid Energy about a billing question on Oscar\'s account and get a human on the line, then bring Oscar in.',
    async play(far) {
      far.speak('Welcome to PowerGrid Energy. For faults and outages, press 1. For billing and payments, press 2. For new connections, press 3. For all other enquiries, press 4.');
      await far.nextKeys(60_000);
      for (const line of [...HOLD_LINES, ...HOLD_LINES]) {
        far.speak(line);
        await far.pause(400);
      }
      await far.pause(5_000);
      far.speak('Hi, you are through to billing, this is Sarah. How can I help you today?');
      await far.reply(90_000);
      far.speak('Sure, I can hold.');
      await far.sawMethod('conference.create', 90_000);
    },
    checks: [
      { name: 'presses 2 for billing', pass: (r) => r.keys.startsWith('2') },
      { name: 'no keys pressed during hold', pass: (r) => r.keys === '2' },
      { name: 'silent through hold music', pass: (r) => saidBetween(r, 'Welcome to PowerGrid', 'you are through to billing') === 0 },
      { name: 'speaks to the human', pass: (r) => saidAfter(r, 'you are through to billing') > 0 },
      { name: 'asks them to hold', pass: (r) => anySaid(r, /\bhold\b/i) },
      { name: 'joins Oscar', pass: (r) => used(r, 'join_requester') && conferenced(r) },
      noErrors,
    ],
  },
  {
    id: 'outbound-speech-ivr',
    title: 'Business with a speech menu ("tell me what you need")',
    direction: 'outbound',
    to: '+61298887777',
    task: 'Call Acme Dental and book a check-up for Oscar next week. Get a human at reception, then bring Oscar in.',
    async play(far) {
      far.speak('Thanks for calling Acme Dental. In a few words, tell me what you are calling about.');
      await far.reply(60_000);
      far.speak('Okay. Is this for a new appointment, or an existing appointment?');
      await far.reply(60_000);
      far.speak('Thanks. Transferring you to reception now.');
      await far.pause(3_000);
      far.speak('Hi, Acme Dental reception, Jess speaking.');
      await far.reply(90_000);
      far.speak('Yes, no problem, I will hold.');
      await far.sawMethod('conference.create', 90_000);
    },
    checks: [
      { name: 'states the reason (appointment/check-up)', pass: (r) => anySaid(r, /appointment|check.?up|book/i) },
      { name: 'answers "new appointment"', pass: (r) => linesAfter(r, 'new appointment, or an existing').some((t) => /\bnew\b/i.test(t) && !/not (sure|certain)/i.test(t)) },
      { name: 'no keypad presses', pass: (r) => r.keys === '' },
      { name: 'joins Oscar after asking to hold', pass: (r) => used(r, 'join_requester') && conferenced(r) },
      noErrors,
    ],
  },
];

function index(r: RunResult, farText: string): number {
  return r.transcript.findIndex((e) => e.speaker === 'far' && e.text.includes(farText));
}

function saidBetween(r: RunResult, fromFar: string, toFar: string): number {
  const from = index(r, fromFar);
  const to = index(r, toFar);
  if (from < 0) return 0;
  // The first reply to the menu is allowed: count agent lines after the first key press.
  const keyAt = r.transcript.findIndex((e, i) => i > from && e.speaker === 'keys');
  const start = keyAt >= 0 ? keyAt : from;
  return r.transcript.slice(start, to < 0 ? undefined : to).filter((e) => e.speaker === 'agent').length;
}

function linesAfter(r: RunResult, farText: string): string[] {
  const at = index(r, farText);
  return at < 0 ? [] : r.transcript.slice(at).filter((e) => e.speaker === 'agent').map((e) => e.text);
}

function saidAfter(r: RunResult, farText: string): number {
  return linesAfter(r, farText).length;
}

