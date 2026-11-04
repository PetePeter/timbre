/**
 * Phone-call scenarios: a scripted far end plus pass/fail checks on what the agent did.
 *
 * Each family is a template filled from variants. Variant 0 of every family is
 * the held-out TEST set (`SCENARIOS`); the rest form the TRAINING set
 * (`TRAINING_SCENARIOS`), so no test wording, name or menu is ever trained on.
 */
import type { RunResult, Scenario } from './harness.js';

const STRANGER = '+61491570199';
const RECEPTION = '+61491570180';
const used = (r: RunResult, tool: string) => r.tools.some((t) => t.name === tool);
const outcome = (r: RunResult, value: string) => r.tools.some((t) => t.name === 'report_call_outcome' && t.args.outcome === value);
const anySaid = (r: RunResult, pattern: RegExp) => r.said.some((s) => pattern.test(s));
const conferenced = (r: RunResult) => r.methods.includes('conference.create');
const noErrors = { name: 'no agent errors', pass: (r: RunResult) => r.errors.length === 0 };

// ---- 1. Outbound call to a person with a message ----
interface PersonVariant { name: string; to: string; task: string; greeting: string; answer: string; keyFact: RegExp; agreed: RegExp }
const PERSON: PersonVariant[] = [
  { name: 'Agnes', to: '+61491570170', task: 'Call Agnes. Tell her dinner on Friday has moved from 6pm to 7pm and check she can still make it.',
    greeting: 'Hello, Agnes speaking.', answer: 'Oh, seven instead of six? Yes, seven is fine. Tell Oscar I will be there.',
    keyFact: /\b(7|seven)(\s?pm)?\b/i, agreed: /\b(yes|confirm|can make|fine|will be there|ok)/i },
  { name: 'Ben', to: '+61491570171', task: 'Call Ben and ask if he can return the ladder he borrowed by Sunday.',
    greeting: 'Yeah, Ben here.', answer: 'The ladder? Sure, I can drop it back Saturday arvo.', keyFact: /ladder/i, agreed: /\b(yes|sure|saturday|will|return|ok)/i },
  { name: 'Priya', to: '+61491570172', task: 'Call Priya. Let her know the school pickup tomorrow is at 2:30 instead of 3:15.',
    greeting: 'Hi, this is Priya.', answer: 'Two thirty, got it. No problem.', keyFact: /\b(2[:.]?30|two.?thirty)\b/i, agreed: /\b(got it|ok|no problem|confirm|yes|fine)/i },
  { name: 'Tom', to: '+61491570173', task: 'Call Tom and tell him the band rehearsal on Wednesday is cancelled.',
    greeting: 'Tom speaking, who is this?', answer: 'Cancelled? Ah, okay, no worries. Thanks for letting me know.', keyFact: /cancel/i, agreed: /\b(ok|no worries|aware|understood|knows|acknowledg|thanks)/i },
  { name: 'Mei', to: '+61491570174', task: 'Call Mei and ask whether she still wants the spare concert ticket for Saturday.',
    greeting: 'Hello?', answer: 'Oh yes please, I definitely want it! How much do I owe?', keyFact: /ticket/i, agreed: /\b(yes|wants|keen|definitely|accept)/i },
  { name: 'Dave', to: '+61491570175', task: 'Call Dave. Remind him the car service booking is at 8am Monday at the Smith Street garage.',
    greeting: 'G\'day, Dave.', answer: 'Eight on Monday, right, I had forgotten. Cheers.', keyFact: /\b(8|eight)\b.*monday|monday.*\b(8|eight)\b/i, agreed: /\b(ok|cheers|reminded|aware|confirm|yes|right)/i },
  { name: 'Lucy', to: '+61491570176', task: 'Call Lucy and ask if the 14th still works for the birthday picnic.',
    greeting: 'Lucy here, hi!', answer: 'The fourteenth? Hmm, yes, that should be fine.', keyFact: /14|fourteenth/i, agreed: /\b(yes|fine|works|confirm|ok)/i },
  { name: 'Raj', to: '+61491570177', task: 'Call Raj. Tell him the parcel he sent arrived safely and say thanks.',
    greeting: 'Hello, Raj speaking.', answer: 'Oh great, glad it got there in one piece!', keyFact: /parcel|package|arrived/i, agreed: /./ },
];
const person = (v: PersonVariant, id: string): Scenario => ({
  id, title: `Call a person with a message (${v.name})`, direction: 'outbound', to: v.to, task: v.task,
  async play(far) {
    far.speak(v.greeting);
    await far.reply(90_000);
    far.speak(v.answer);
    await far.reply(60_000);
    if (!far.ended) far.speak('Okay, thanks, bye!');
    await far.sawMethod('call.hangup', 30_000);
  },
  checks: [
    { name: 'states the key fact', pass: (r) => anySaid(r, v.keyFact) },
    { name: 'ends the call with hang_up', pass: (r) => used(r, 'hang_up') },
    { name: 'summary reports the answer', pass: (r) => r.tools.some((t) => t.name === 'hang_up' && v.agreed.test(String(t.args.summary))) },
    { name: 'no keypad presses', pass: (r) => r.keys === '' },
    { name: 'does not ring the owner', pass: (r) => !conferenced(r) },
    noErrors,
  ],
});

// ---- 2. Stranger leaves a message ----
interface MessageVariant { opener: string; message: string }
const MESSAGE: MessageVariant[] = [
  { opener: 'Hi, this is Mark from Smith Plumbing. Is Oscar there?',
    message: 'Yes please. Tell him the part for his hot water system has arrived and we can fit it Thursday morning. My number is 0412 555 019.' },
  { opener: 'Hello, it\'s Karen from the library. Could I speak to Oscar?', message: 'Sure. The book he reserved is ready to collect, we hold it for one week.' },
  { opener: 'Hey, Jamal from Northside Football Club here. Is Oscar around?', message: 'Can you tell him training moves to Thursday at six this week. Call me on 0400 112 233 if that is a problem.' },
  { opener: 'Good morning, this is Fiona at Greenleaf Vets.', message: 'Just letting Oscar know Biscuit is due for her vaccination. He can book online or call us back.' },
  { opener: 'Hi there, it\'s Steve, I am a friend of Oscar\'s from uni.', message: 'Tell him I am in town next weekend and would love to grab a beer. He has my number.' },
  { opener: 'Hello, my name is Grace, I am calling from City Council about a bin request.', message: 'The replacement recycling bin will be delivered on Tuesday. No action needed.' },
  { opener: 'Yeah hi, Luke from Fast Fix Electrical. Oscar asked for a quote.', message: 'The quote for the new power points is four hundred and twenty dollars. I will email it too.' },
  { opener: 'Hi, this is Amelia, the neighbour from number twelve.', message: 'Your side gate was open this morning so I closed it. Just so he knows.' },
];
const message = (v: MessageVariant, id: string): Scenario => ({
  id, title: 'Stranger calls and leaves a message', direction: 'inbound', caller: STRANGER,
  async play(far) {
    await far.reply(60_000);
    far.speak(v.opener);
    await far.reply(60_000);
    far.speak(v.message);
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
});

// ---- 3. Stranger asks to be put through ----
interface TransferVariant { target: string; request: string }
const TRANSFER: TransferVariant[] = [
  { target: 'Reception', request: 'Hi, I need to speak to someone about an urgent delivery. Can you put me through to a person please?' },
  { target: 'Front Desk', request: 'Hello, can I talk to a real person? It is about a booking.' },
  { target: 'Office', request: 'Hi, could you transfer me to someone who can help with an invoice?' },
  { target: 'Assistant', request: 'I would rather not leave a message. Can you connect me with somebody now?' },
  { target: 'Reception', request: 'Hey, is there anyone there I can speak with directly? It is a bit urgent.' },
  { target: 'Help Desk', request: 'Can you put me through please? I have a question about my order.' },
];
const transfer = (v: TransferVariant, id: string): Scenario => ({
  id, title: 'Stranger asks to be put through', direction: 'inbound', caller: STRANGER,
  addressBook: [{ id: 'target-id', name: v.target, numbers: [RECEPTION], group: 'Work', trusted: false, isUser: false, transferTarget: true, defaultTransfer: true }],
  async play(far) {
    await far.reply(60_000);
    far.speak(v.request);
    await far.sawMethod('conference.create', 90_000);
  },
  checks: [
    { name: 'transfers with transfer_to_contact', pass: (r) => used(r, 'transfer_to_contact') },
    { name: 'conference created', pass: (r) => conferenced(r) },
    { name: 'does not record a message instead', pass: (r) => !outcome(r, 'left_message') },
    noErrors,
  ],
});

// ---- 4. Silent caller ----
interface SilentVariant { noise?: string }
const SILENT: SilentVariant[] = [{}, { noise: '(inaudible)' }, { noise: '(background noise)' }, {}];
const silent = (v: SilentVariant, id: string): Scenario => ({
  id, title: 'Caller never says anything', direction: 'inbound', caller: STRANGER,
  async play(far) {
    await far.reply(60_000);
    if (v.noise) far.speak(v.noise);
    await far.pause(20_000);
  },
  checks: [
    { name: 'greets', pass: (r) => r.said.length > 0 },
    { name: 'does not invent a message', pass: (r) => !outcome(r, 'left_message') },
    { name: 'does not transfer', pass: (r) => !conferenced(r) },
    { name: 'does not talk on and on (max 3 lines)', pass: (r) => r.said.length <= 3 },
    noErrors,
  ],
});

// ---- 5. Cut off mid-message ----
const CUT_OFF: string[] = [
  'Hi, it is Julia from the dentist, I am calling to move Oscar\'s appointment to',
  'Hello, this is Paul from the bank regarding your recent',
  'Hey Oscar it\'s me, listen, about tonight, I think we should',
  'Good afternoon, I am calling from the school about your son, he',
  'Hi, it\'s the courier, I am outside with a parcel and I need',
];
const cutOff = (opener: string, id: string): Scenario => ({
  id, title: 'Call cut off mid-message', direction: 'inbound', caller: STRANGER,
  async play(far) {
    await far.reply(60_000);
    far.speak(opener);
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
});

// ---- 6. Keypad menu, long hold with lyrics, then a human ----
interface HoldVariant { company: string; to: string; purpose: string; menu: string; digit: string; hold: string[]; human: string }
const HOLD: HoldVariant[] = [
  { company: 'PowerGrid Energy', to: '+61291234567', purpose: 'a billing question on Oscar\'s account',
    menu: 'Welcome to PowerGrid Energy. For faults and outages, press 1. For billing and payments, press 2. For new connections, press 3. For all other enquiries, press 4.',
    digit: '2', human: 'Hi, you are through to billing, this is Sarah. How can I help you today?',
    hold: [
      'Thank you for calling PowerGrid Energy. Your call is important to us. Please stay on the line.',
      'Are you lonely tonight? Do you miss me tonight?', 'Can you hear me calling, calling out your name?',
      'Your estimated wait time is 58 minutes.', 'Hold me closer, tiny dancer, count the headlights on the highway.',
      'Did you know you can pay your bill online at powergrid dot com dot au?', 'Is this the real life? Is this just fantasy?',
      'Your call is important to us. Please continue to hold.', 'Hello, is it me you are looking for?',
      'Your estimated wait time is 31 minutes.', 'And I will always love you, I will always love you.',
      'Thank you for your patience. A consultant will be with you shortly.',
    ] },
  { company: 'Telstar Mobile', to: '+61291230001', purpose: 'a roaming charge on Oscar\'s bill',
    menu: 'Thanks for calling Telstar. To report a lost phone, press 1. For accounts and billing, press 2. For technical support, press 3.',
    digit: '2', human: 'Telstar accounts, Mike speaking. What can I do for you?',
    hold: ['All our operators are busy.', 'Don\'t stop believing, hold on to that feeling.', 'Would you like me to call you back? No? Okay.',
      'Your wait time is approximately forty minutes.', 'We will rock you, we will we will rock you.', 'Who let the dogs out? Who, who?',
      'Please hold, your call is important to us.', 'Do you really want to hurt me?'] },
  { company: 'Sunrise Insurance', to: '+61291230002', purpose: 'making a claim for Oscar\'s car',
    menu: 'Welcome to Sunrise Insurance. For a new quote, press 1. To make or check a claim, press 3. For payments, press 4. To hear these options again, press 9.',
    digit: '3', human: 'Claims team, this is Nadia, may I have your policy number?',
    hold: ['Your call is in a queue.', 'Is anybody out there? Can anybody hear me?', 'Hey, are you listening?',
      'Did you know you can lodge a claim online?', 'Here comes the sun, do do do do.', 'Your estimated wait is twenty-five minutes.',
      'Can I get a witness?', 'Thank you for holding.'] },
  { company: 'City Water', to: '+61291230003', purpose: 'reporting a leaking water meter at Oscar\'s house',
    menu: 'City Water. For emergencies and leaks, press 1. For accounts, press 2. For everything else, press 0.',
    digit: '1', human: 'Hi, faults line, Ahmed here. What is the address?',
    hold: ['You are caller number seven.', 'Should I stay or should I go now?', 'Are you ready? Are you ready for this?',
      'Please do not hang up.', 'Rain drops keep falling on my head.', 'Do you know the way to San Jose?', 'Thanks for your patience.'] },
  { company: 'QuickNet Broadband', to: '+61291230004', purpose: 'Oscar\'s internet dropping out every evening',
    menu: 'QuickNet. For sales, press 1. For billing, press 2. For faults and technical help, press 3.',
    digit: '3', human: 'Tech support, Lena speaking, can you tell me what is happening with the connection?',
    hold: ['Have you tried turning your modem off and on again?', 'What is love? Baby don\'t hurt me.', 'Can you feel the love tonight?',
      'Your call will be answered shortly.', 'Every breath you take, every move you make.', 'Call me maybe?', 'Estimated wait: 52 minutes.',
      'We appreciate your patience.'] },
  { company: 'Harbour Bank', to: '+61291230005', purpose: 'a card that was declined for Oscar this morning',
    menu: 'Welcome to Harbour Bank. For lost or stolen cards, press 1. For card enquiries, press 2. For home loans, press 3. For anything else, press 5.',
    digit: '2', human: 'Harbour Bank cards, my name is Olivia. How can I help?',
    hold: ['For security, never share your PIN.', 'Hey Jude, don\'t make it bad.', 'Why do birds suddenly appear?',
      'Your call is important to us.', 'Wake me up before you go-go.', 'Did you know about our new savings account?', 'Please continue to hold.'] },
  { company: 'Metro Council', to: '+61291230006', purpose: 'a missed bin collection at Oscar\'s street',
    menu: 'Metro Council. For parking and fines, press 1. For waste and recycling, press 2. For rates, press 3.',
    digit: '2', human: 'Waste services, Ken speaking.',
    hold: ['You are in a queue.', 'I just called to say I love you.', 'Do you want to know a secret?', 'Your wait time is about thirty minutes.',
      'Walking on sunshine, whoa-oh.', 'Thank you for waiting.'] },
];
const hold = (v: HoldVariant, id: string): Scenario => ({
  id, title: `Business: keypad menu, long hold, then a human (${v.company})`, direction: 'outbound', to: v.to,
  task: `Call ${v.company} about ${v.purpose} and get a human on the line, then bring Oscar in.`,
  async play(far) {
    far.speak(v.menu);
    await far.nextKeys(60_000);
    for (const line of [...v.hold, ...v.hold]) {
      far.speak(line);
      await far.pause(400);
    }
    await far.pause(5_000);
    far.speak(v.human);
    await far.reply(90_000);
    far.speak('Sure, I can hold.');
    await far.sawMethod('conference.create', 90_000);
  },
  checks: [
    { name: 'presses the right option', pass: (r) => r.keys.startsWith(v.digit) },
    { name: 'no keys pressed during hold', pass: (r) => r.keys === v.digit },
    { name: 'silent through hold music', pass: (r) => saidBetween(r, v.menu, v.human) === 0 },
    { name: 'speaks to the human', pass: (r) => linesAfter(r, v.human).length > 0 },
    { name: 'asks them to hold', pass: (r) => anySaid(r, /\bhold\b/i) },
    { name: 'joins Oscar', pass: (r) => used(r, 'join_requester') && conferenced(r) },
    noErrors,
  ],
});

// ---- 7. Speech-driven phone menu ----
interface SpeechVariant { company: string; to: string; goal: string; prompt: string; reason: RegExp; question: string; answer: RegExp; receptionist: string }
const SPEECH: SpeechVariant[] = [
  { company: 'Acme Dental', to: '+61298887777', goal: 'book a check-up for Oscar next week',
    prompt: 'Thanks for calling Acme Dental. In a few words, tell me what you are calling about.', reason: /appointment|check.?up|book/i,
    question: 'Okay. Is this for a new appointment, or an existing appointment?', answer: /\bnew\b/i, receptionist: 'Hi, Acme Dental reception, Jess speaking.' },
  { company: 'Northside Medical', to: '+61298880001', goal: 'get a repeat prescription sorted for Oscar',
    prompt: 'Welcome to Northside Medical. Please say the reason for your call.', reason: /prescription|script|medic/i,
    question: 'Is this for a new prescription or a repeat?', answer: /\brepeat\b/i, receptionist: 'Northside Medical, this is Carol.' },
  { company: 'Speedy Couriers', to: '+61298880002', goal: 'find out where Oscar\'s parcel is',
    prompt: 'Speedy Couriers. Briefly, how can we help today?', reason: /parcel|package|deliver|track/i,
    question: 'Are you sending a parcel or receiving one?', answer: /receiv/i, receptionist: 'Customer care, Tim here.' },
  { company: 'Bright Smile Orthodontics', to: '+61298880003', goal: 'move Oscar\'s existing appointment to a later date',
    prompt: 'You have reached Bright Smile. Tell me what you need, for example book, change or cancel.', reason: /change|move|reschedul/i,
    question: 'Got it. Do you want to change an existing booking or make a new one?', answer: /exist|change/i, receptionist: 'Bright Smile front desk, Ana speaking.' },
  { company: 'Green Thumb Landscaping', to: '+61298880004', goal: 'get a quote for Oscar\'s back garden',
    prompt: 'Hi, you have called Green Thumb. Say quote, booking, or something else.', reason: /quote/i,
    question: 'Is this for a residential or a commercial property?', answer: /residential|home|house/i, receptionist: 'Green Thumb, Bruce speaking.' },
  { company: 'Cityline Taxis', to: '+61298880005', goal: 'report a phone Oscar left in a taxi last night',
    prompt: 'Cityline Taxis. Please tell me why you are calling.', reason: /lost|left|phone|property/i,
    question: 'Is this about a lost item or a complaint?', answer: /lost|item/i, receptionist: 'Lost property, Gemma speaking.' },
  { company: 'Pacific Airlines', to: '+61298880006', goal: 'ask about adding a checked bag to Oscar\'s booking',
    prompt: 'Welcome to Pacific Airlines. In a few words, what is your call about?', reason: /bag|luggage|baggage/i,
    question: 'Do you have an existing booking with us?', answer: /\byes\b|existing|have/i, receptionist: 'Pacific Airlines, this is Ravi.' },
];
const speech = (v: SpeechVariant, id: string): Scenario => ({
  id, title: `Business with a speech menu (${v.company})`, direction: 'outbound', to: v.to,
  task: `Call ${v.company} and ${v.goal}. Get a human at reception, then bring Oscar in.`,
  async play(far) {
    far.speak(v.prompt);
    await far.reply(60_000);
    far.speak(v.question);
    await far.reply(60_000);
    far.speak('Thanks. Transferring you now.');
    await far.pause(3_000);
    far.speak(v.receptionist);
    await far.reply(90_000);
    far.speak('Yes, no problem, I will hold.');
    await far.sawMethod('conference.create', 90_000);
  },
  checks: [
    { name: 'states the reason', pass: (r) => anySaid(r, v.reason) },
    { name: 'answers the menu question', pass: (r) => linesAfter(r, v.question).some((t) => v.answer.test(t) && !/not (sure|certain)/i.test(t)) },
    { name: 'no keypad presses', pass: (r) => r.keys === '' },
    { name: 'joins Oscar after asking to hold', pass: (r) => used(r, 'join_requester') && conferenced(r) },
    noErrors,
  ],
});

const FAMILIES: Array<{ id: string; build: (i: number, id: string) => Scenario; count: number }> = [
  { id: 'outbound-person', build: (i, id) => person(PERSON[i], id), count: PERSON.length },
  { id: 'inbound-stranger-message', build: (i, id) => message(MESSAGE[i], id), count: MESSAGE.length },
  { id: 'inbound-stranger-transfer', build: (i, id) => transfer(TRANSFER[i], id), count: TRANSFER.length },
  { id: 'inbound-silent', build: (i, id) => silent(SILENT[i], id), count: SILENT.length },
  { id: 'inbound-cut-off', build: (i, id) => cutOff(CUT_OFF[i], id), count: CUT_OFF.length },
  { id: 'outbound-ivr-hold', build: (i, id) => hold(HOLD[i], id), count: HOLD.length },
  { id: 'outbound-speech-ivr', build: (i, id) => speech(SPEECH[i], id), count: SPEECH.length },
];

/** Held-out test set: variant 0 of each family. Never used for training. */
export const SCENARIOS: Scenario[] = FAMILIES.map((f) => f.build(0, f.id));

/** Training set: every other variant. */
export const TRAINING_SCENARIOS: Scenario[] = FAMILIES.flatMap((f) =>
  Array.from({ length: f.count - 1 }, (_, n) => f.build(n + 1, `${f.id}#${n + 1}`)));

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

