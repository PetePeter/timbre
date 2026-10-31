/**
 * Phone line (telefony-app over PhAP) settings and the single policy decision
 * every call/SMS action passes through. Pure: no I/O, no clock of its own.
 *
 * Two layers enforce: telefony-app's allowlist (exact numbers, outbound only)
 * and this policy (per-action, per-number, rate limits, quiet hours). The
 * generated allowlist is derived from these contacts, so a Timbre bug can narrow
 * access but never widen it past what telefony itself permits.
 */
import { isHandlingAction, type InboundHandlingConfig, type InboundHandlingPolicy, type InboundRule } from './inbound-call-policy.js';
import { createScheduleSlotId, defaultPhoneSchedule, isClockTime, isTimeZone, type PhoneSchedule } from './schedule.js';
import { NO_SMS_AUTO_REPLY, normalizeSmsAutoReply } from './sms-auto-reply-policy.js';

export type PhoneAction = 'call.in' | 'call.out' | 'sms.in' | 'sms.out' | 'sms.reply' | 'sms.read' | 'conf.add';
export type PhoneRole = 'owner' | 'trusted';
export type SpamAction = 'block' | 'screen';
export type InboundMode = 'normal' | 'busy' | 'dnd';
export type UnknownCallerMode = 'allow' | 'screen' | 'block';

export interface PhoneContact {
  contactId?: string;
  label: string;
  /** E.164, national (0…) or a prefix ending in `*`. */
  pattern: string;
  role: PhoneRole;
  callIn: boolean;
  callOut: boolean;
  smsIn: boolean;
  smsOut: boolean;
  conf: boolean;
  /** Deprecated config field. PINs are kept in the contact PIN store and this stays empty. */
  pin: string;
  /** Receives messages a stranger leaves without naming anyone. */
  messages: boolean;
}

export interface PhoneContactPolicy {
  contactId?: string;
  /** Prefix-only legacy rules have no address-book identity. */
  pattern?: string;
  label?: string;
  role: PhoneRole | 'blocked';
  callIn: boolean;
  callOut: boolean;
  smsIn: boolean;
  smsOut: boolean;
  conf: boolean;
  pin: string;
  messages: boolean;
}

export interface PhoneLineConfig {
  /** Instant per-phone inbound override; normal follows handling rules and schedule. */
  inboundMode: InboundMode;
  enabled: boolean;
  transport: string;
  /** Bluetooth name advertised by telefony-app for this phone line. */
  deviceName: string;
  port: number;
  token: string;
  heartbeatS: number;
  watchdog: boolean;
  ringFallback: 'ring' | 'reject';
  ringTimeoutS: number;
  countryCode: string;
  /** Connected SIM number. Empty disables automatic SMS replies. */
  localNumber: string;
  masters: { callIn: boolean; callOut: boolean; smsIn: boolean; smsOut: boolean; conference: boolean };
  screening: { allow: InboundRule[]; block: InboundRule[]; acceptPrivate: boolean; unknownCallers: UnknownCallerMode };
  spam: { threshold: number; action: SpamAction };
  inboundHandling: InboundHandlingConfig;
  schedule: PhoneSchedule;
  contactRules: PhoneContactPolicy[];
  /** Derived read-only compatibility shim for telefony-process. */
  contacts: PhoneContact[];
  smsRead: { scope: 'received' | 'window' | 'all' | 'none'; windowMin: number; maskOtp: boolean };
  /**
   * Regexes; a number matching any one (as E.164 `+61…` or national `0…`) is
   * refused every call and SMS, in and out, whoever asks.
   */
  blocklist: string[];
  limits: { callsPerHour: number; smsPerHour: number; maxCallMin: number; quietStart: string; quietEnd: string };
  persona: {
    name: string;
    tone: string;
    instructions: string;
    greetIn: boolean;
    greetInText: string;
    /** What callers not in the list hear. Never names the assistant or anyone. */
    greetStranger: string;
    greetOut: boolean;
    greetOutText: string;
    discloseAi: boolean;
    signSms: boolean;
  };
  voice: { tts: 'auto' | 'piper' | 'sapi' | 'none'; piperModel: string; sapiVoice: string; sttModel: string };
  recordingNotice: { enabled: boolean; text: string };
  recordings: { retentionDays: number };
  transcripts: {
    enabled: boolean;
    /** Text the owner a short summary when a call ends. */
    smsSummary: boolean;
    /** Empty = the Timbre user-data dir. */
    folder: string;
    fileName: string;
    format: 'md' | 'json' | 'both';
    retentionDays: number;
  };
  conference: { maxParticipants: number; announce: boolean };
  /** When the Timbre phone app is offline: ring_user dials the owner, notify_user texts them. */
  fallback: { ring: boolean; notify: boolean };
  /** The API tool (CLI type id) whose model runs call agents; empty = no call agents. */
  callAgentModel: string;
  /** The API tool whose fast model says a holding line while the operator thinks; empty = off. */
  callReplyModel: string;
}

/** telefony-app's GitHub repo: the installer's source, and the manual-download link in Settings. */
export const TELEFONY_REPO = 'PetePeter/telefony-app';
export const TELEFONY_RELEASES_PAGE = `https://github.com/${TELEFONY_REPO}/releases`;
export const TELEFONY_PHAP_SCHEMA_PAGE = `https://github.com/${TELEFONY_REPO}/blob/main/src/telefony_app/phap/schema-2026-10-27.json`;
export const DEFAULT_RECORDING_NOTICE_TEXT = 'This call may be recorded.';
export const BLUETOOTH_DEVICE_NAME_MAX_BYTES = 248;

export function defaultBluetoothDeviceName(phoneName: string): string {
  return truncateUtf8(`Timbre - ${phoneName.trim() || 'Phone'}`);
}

export function normalizeBluetoothDeviceName(value: unknown, phoneName: string): string {
  const requested = typeof value === 'string' ? value.trim() : '';
  return truncateUtf8(requested || defaultBluetoothDeviceName(phoneName));
}

function truncateUtf8(value: string): string {
  let byteLength = 0;
  let result = '';
  const encoder = new TextEncoder();
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (byteLength + characterBytes > BLUETOOTH_DEVICE_NAME_MAX_BYTES) break;
    result += character;
    byteLength += characterBytes;
  }
  return result;
}

export const DEFAULT_PHONE_LINE_CONFIG: PhoneLineConfig = {
  inboundMode: 'normal',
  enabled: false,
  transport: '',
  deviceName: 'Timbre - Phone',
  port: 7781,
  token: '',
  heartbeatS: 10,
  watchdog: true,
  ringFallback: 'ring',
  ringTimeoutS: 15,
  countryCode: '+61',
  localNumber: '',
  masters: { callIn: true, callOut: true, smsIn: true, smsOut: true, conference: false },
  screening: { allow: [], block: [], acceptPrivate: true, unknownCallers: 'screen' },
  spam: { threshold: 60, action: 'screen' },
  inboundHandling: { default: { action: 'standard', greeting: '', instructions: '', smsAutoReply: NO_SMS_AUTO_REPLY }, rules: [] },
  schedule: defaultPhoneSchedule(),
  contactRules: [],
  contacts: [],
  smsRead: { scope: 'window', windowMin: 30, maskOtp: true },
  limits: { callsPerHour: 3, smsPerHour: 10, maxCallMin: 15, quietStart: '', quietEnd: '' },
  blocklist: [],
  persona: {
    name: 'Timbre',
    tone: '',
    instructions: '',
    greetIn: true,
    greetInText: "Hi {caller}, it's {name}. What do you need?",
    greetStranger: "Welcome, you've reached an answering machine, but a slightly more modern one. Who were you calling? Or say message to leave a message.",
    greetOut: true,
    greetOutText: 'Hi {caller}, this is {name}. {reason}',
    discloseAi: true,
    signSms: false,
  },
  voice: { tts: 'auto', piperModel: '', sapiVoice: '', sttModel: '' },
  recordingNotice: { enabled: true, text: DEFAULT_RECORDING_NOTICE_TEXT },
  recordings: { retentionDays: 90 },
  transcripts: { enabled: true, smsSummary: true, folder: '', fileName: '{yyyy}/{mm}/{yyyy}-{mm}-{dd}_{HHmm}_{label}_{direction}', format: 'md', retentionDays: 90 },
  conference: { maxParticipants: 3, announce: true },
  fallback: { ring: true, notify: false },
  callAgentModel: '',
  callReplyModel: '',
};

export function isValidRetentionDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isValidSpamThreshold(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100;
}

/** Deep-merge a partial (e.g. parsed YAML) over the defaults; unknown keys are dropped. */
export function resolvePhoneLineConfig(raw: unknown): PhoneLineConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PHONE_LINE_CONFIG;
  const pick = <T extends object>(def: T, v: unknown): T => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const out = { ...def } as Record<string, unknown>;
    for (const k of Object.keys(def)) if (typeof o[k] === typeof (def as Record<string, unknown>)[k]) out[k] = o[k];
    return out as T;
  };
  const retentionDays = (value: number, fallback: number) => isValidRetentionDays(value) ? value : fallback;
  const base = pick({ ...d, masters: undefined, screening: undefined, spam: undefined, inboundHandling: undefined, schedule: undefined, contactRules: undefined, contacts: undefined, fallback: undefined, smsRead: undefined, limits: undefined, persona: undefined, voice: undefined, recordingNotice: undefined, recordings: undefined, transcripts: undefined, conference: undefined } as unknown as PhoneLineConfig, src);
  base.deviceName = normalizeBluetoothDeviceName(base.deviceName, 'Phone');
  const validPin = (_pin: unknown) => '';
  // Before per-contact PINs there was one `ownerPin`; it belongs to the owner row.
  const legacyOwnerPin = validPin(src.ownerPin);
  const rows = Array.isArray(src.contacts)
    ? src.contacts.map((raw) => {
      const c = pick<PhoneContact>({ label: '', pattern: '', role: 'trusted', callIn: false, callOut: false, smsIn: false, smsOut: false, conf: false, pin: '', messages: false }, raw);
      // Rows saved before the switch existed: the owner gets general messages.
      return typeof (raw as Record<string, unknown> | null)?.messages === 'boolean' ? c : { ...c, messages: c.role === 'owner' };
    })
      // Rows with no number yet stay (the user is still typing); they never match anything.
      .filter((c) => ['owner', 'trusted', 'blocked'].includes(c.role as string))
    : [];
  // Blocked used to be a contact role; those rows now live in the block list.
  const legacyBlocks = rows.filter((c) => (c.role as string) === 'blocked').map((c) => patternToRegex(c.pattern, (base.countryCode as string)))
    .filter((r): r is string => r !== null);
  const legacyContacts = rows.filter((c) => (c.role as string) !== 'blocked')
    // Owner rights belong to one number, never a whole prefix.
    .map((c) => (c.role === 'owner' && c.pattern.trim().endsWith('*') ? { ...c, role: 'trusted' as const } : c))
    .map((c) => ({ ...c, pin: validPin(c.pin) || (c.role === 'owner' ? legacyOwnerPin : '') }));
  const canonicalRules = Array.isArray(src.contactRules) ? src.contactRules as unknown[] : null;
  const hasCanonicalRules = canonicalRules !== null && (canonicalRules.length > 0 || !Array.isArray(src.contacts));
  const contactRules = hasCanonicalRules
    ? canonicalRules!.flatMap((value: unknown): PhoneContactPolicy[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const o = value as Record<string, unknown>;
      if (o.role !== 'owner' && o.role !== 'trusted' && o.role !== 'blocked') return [];
      const contactId = typeof o.contactId === 'string' && o.contactId ? o.contactId : undefined;
      const pattern = typeof o.pattern === 'string' ? o.pattern : undefined;
      const label = typeof o.label === 'string' ? o.label : undefined;
      return [{
        ...(contactId ? { contactId } : {}),
        ...(pattern !== undefined ? { pattern } : {}),
        ...(label !== undefined ? { label } : {}),
        role: o.role,
        callIn: typeof o.callIn === 'boolean' ? o.callIn : false,
        callOut: typeof o.callOut === 'boolean' ? o.callOut : false,
        smsIn: typeof o.smsIn === 'boolean' ? o.smsIn : false,
        smsOut: typeof o.smsOut === 'boolean' ? o.smsOut : false,
        conf: typeof o.conf === 'boolean' ? o.conf : false,
        pin: validPin(o.pin),
        messages: typeof o.messages === 'boolean' ? o.messages : o.role === 'owner',
      }];
    })
    : legacyContacts.map((contact) => ({ ...contact }));
  // So did the short-lived `limits.blockedPrefixes` (cost prefixes).
  const legacyPrefixes = ((src.limits as { blockedPrefixes?: unknown } | undefined)?.blockedPrefixes);
  if (Array.isArray(legacyPrefixes)) {
    for (const p of legacyPrefixes) {
      const re = typeof p === 'string' ? patternToRegex(`${p.replace(/\*$/, '')}*`, base.countryCode as string) : null;
      if (re) legacyBlocks.push(re);
    }
  }
  const blocklist = [...(Array.isArray(src.blocklist) ? src.blocklist : []), ...legacyBlocks]
    .filter((r): r is string => typeof r === 'string' && r.trim() !== '' && isValidRegularExpression(r));
  const screeningRaw = src.screening && typeof src.screening === 'object' ? src.screening as Record<string, unknown> : {};
  const rules = (value: unknown): InboundRule[] => Array.isArray(value) ? value.flatMap((entry): InboundRule[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const rule = entry as Record<string, unknown>;
    if ((rule.kind !== 'contact' && rule.kind !== 'group' && rule.kind !== 'number')
      || typeof rule.value !== 'string' || !rule.value.trim()) return [];
    return [{ kind: rule.kind, value: rule.value.trim() }];
  }) : [];
  const screening = {
    allow: rules(screeningRaw.allow),
    block: rules(screeningRaw.block),
    acceptPrivate: typeof screeningRaw.acceptPrivate === 'boolean' ? screeningRaw.acceptPrivate : d.screening.acceptPrivate,
    unknownCallers: screeningRaw.unknownCallers === 'allow' || screeningRaw.unknownCallers === 'block' || screeningRaw.unknownCallers === 'screen'
      ? screeningRaw.unknownCallers : d.screening.unknownCallers,
  };
  const inboundMode: InboundMode = src.inboundMode === 'busy' || src.inboundMode === 'dnd' || src.inboundMode === 'normal'
    ? src.inboundMode : d.inboundMode;
  const spamRaw = src.spam && typeof src.spam === 'object' && !Array.isArray(src.spam)
    ? src.spam as Record<string, unknown> : {};
  const spam = {
    threshold: isValidSpamThreshold(spamRaw.threshold) ? spamRaw.threshold : d.spam.threshold,
    action: spamRaw.action === 'block' || spamRaw.action === 'screen' ? spamRaw.action : d.spam.action,
  };
  const handlingRaw = src.inboundHandling && typeof src.inboundHandling === 'object' && !Array.isArray(src.inboundHandling)
    ? src.inboundHandling as Record<string, unknown> : {};
  const handlingPolicy = (value: unknown, fallback: InboundHandlingPolicy): InboundHandlingPolicy => {
    const policy = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
      action: isHandlingAction(policy.action) ? policy.action : fallback.action,
      greeting: typeof policy.greeting === 'string' ? policy.greeting : fallback.greeting,
      instructions: typeof policy.instructions === 'string' ? policy.instructions : fallback.instructions,
      smsAutoReply: normalizeSmsAutoReply(policy.smsAutoReply, fallback.smsAutoReply),
    };
  };
  const inboundHandling: InboundHandlingConfig = {
    default: handlingPolicy(handlingRaw.default, d.inboundHandling.default),
    rules: Array.isArray(handlingRaw.rules) ? handlingRaw.rules.flatMap((value): InboundHandlingConfig['rules'] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const rule = value as Record<string, unknown>;
      if ((rule.kind !== 'contact' && rule.kind !== 'group') || typeof rule.value !== 'string' || !rule.value.trim()) return [];
      return [{ kind: rule.kind, value: rule.value.trim(), ...handlingPolicy(rule, d.inboundHandling.default) }];
    }) : [],
  };
  const scheduleRaw = src.schedule && typeof src.schedule === 'object' && !Array.isArray(src.schedule)
    ? src.schedule as Record<string, unknown> : {};
  const defaultSchedule = defaultPhoneSchedule();
  const timeZone = typeof scheduleRaw.timeZone === 'string' && isTimeZone(scheduleRaw.timeZone)
    ? scheduleRaw.timeZone : defaultSchedule.timeZone;
  const schedule: PhoneSchedule = {
    timeZone,
    slots: Array.isArray(scheduleRaw.slots) ? scheduleRaw.slots.flatMap((value): PhoneSchedule['slots'] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const slot = value as Record<string, unknown>;
      const days = Array.isArray(slot.days)
        ? [...new Set(slot.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))]
        : [];
      const start = typeof slot.start === 'string' ? slot.start : '';
      const end = typeof slot.end === 'string' ? slot.end : '';
      if (!days.length || !isClockTime(start) || !isClockTime(end) || start === end || !isHandlingAction(slot.action)) return [];
      const id = typeof slot.id === 'string' && slot.id.trim() ? slot.id.trim() : createScheduleSlotId();
      return [{ id, days, start, end, ...handlingPolicy(slot, d.inboundHandling.default) }];
    }) : [],
  };
  const recordings = pick(d.recordings, src.recordings);
  recordings.retentionDays = retentionDays(recordings.retentionDays, d.recordings.retentionDays);
  const transcripts = pick(d.transcripts, src.transcripts);
  transcripts.retentionDays = retentionDays(transcripts.retentionDays, d.transcripts.retentionDays);
  const contacts = contactRules.flatMap((rule): PhoneContact[] => rule.role === 'blocked' || rule.pattern === undefined ? [] : [{
    ...(rule.contactId ? { contactId: rule.contactId } : {}),
    label: rule.label ?? '', pattern: rule.pattern, role: rule.role,
    callIn: rule.callIn, callOut: rule.callOut, smsIn: rule.smsIn, smsOut: rule.smsOut,
    conf: rule.conf, pin: rule.pin, messages: rule.messages,
  }]);
  return {
    ...base,
    inboundMode,
    masters: pick(d.masters, src.masters),
    screening,
    spam,
    inboundHandling,
    schedule,
    contactRules,
    contacts,
    blocklist: [...new Set(blocklist)],
    smsRead: pick(d.smsRead, src.smsRead),
    limits: pick(d.limits, src.limits),
    persona: pick(d.persona, src.persona),
    voice: pick(d.voice, src.voice),
    recordingNotice: pick(d.recordingNotice, src.recordingNotice),
    recordings,
    transcripts,
    conference: pick(d.conference, src.conference),
    fallback: pick(d.fallback, src.fallback),
  };
}

/**
 * Normalise to `+<digits>`, reading national numbers (leading 0) with the
 * country code. Returns null for withheld/private or anything with characters
 * that are not part of a phone number.
 */
export function normalizeNumber(raw: string, countryCode: string): string | null {
  const s = raw.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d{3,}$/.test(s)) return null;
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return `+${s.slice(2)}`;
  if (s.startsWith('0')) return `${countryCode}${s.slice(1)}`;
  if (NO_TRUNK_PREFIX[countryCode]?.test(s)) return `${countryCode}${s}`;
  return `+${s}`;
}

/** National numbers dialled without a leading 0 (Australia's 13 / 1300 / 1800 / 19xx). */
const NO_TRUNK_PREFIX: Record<string, RegExp | undefined> = { '+61': /^1[389]\d{4,8}$/ };

interface Match { contact: PhoneContact; specificity: number }

function matchContacts(number: string, cfg: PhoneLineConfig): Match[] {
  const out: Match[] = [];
  for (const contact of cfg.contacts) {
    const p = contact.pattern.trim();
    if (p.endsWith('*')) {
      const prefix = normalizeNumber(p.slice(0, -1), cfg.countryCode);
      if (prefix && number.startsWith(prefix)) out.push({ contact, specificity: prefix.length });
    } else {
      const exact = normalizeNumber(p, cfg.countryCode);
      if (exact === number) out.push({ contact, specificity: Number.MAX_SAFE_INTEGER });
    }
  }
  return out.sort((a, b) => b.specificity - a.specificity);
}

/** The contact a number resolves to (most specific match), ignoring permissions. */
export function findContact(raw: string, cfg: PhoneLineConfig): PhoneContact | null {
  const n = normalizeNumber(raw, cfg.countryCode);
  return n ? matchContacts(n, cfg)[0]?.contact ?? null : null;
}

export function ownerContact(cfg: PhoneLineConfig): PhoneContact | null {
  return cfg.contacts.find((c) => c.role === 'owner' && !c.pattern.includes('*')) ?? null;
}

export interface DecideContext {
  now: Date;
  /** Outbound actions already taken in the last hour. */
  callsLastHour: number;
  smsLastHour: number;
  /** Live conference size including Timbre, for conf.add. */
  participants?: number;
  /** ring_user to the owner may ring through quiet hours. */
  urgent?: boolean;
}

export type Decision =
  | { allow: true; contact: PhoneContact; number: string }
  | { allow: false; reason: string };

const MASTER: Record<PhoneAction, (m: PhoneLineConfig['masters']) => boolean> = {
  'call.in': (m) => m.callIn,
  'call.out': (m) => m.callOut,
  'sms.in': (m) => m.smsIn,
  'sms.out': (m) => m.smsOut,
  'sms.reply': (m) => m.smsOut,
  'sms.read': (m) => m.smsIn,
  'conf.add': (m) => m.conference && m.callOut,
};

const PER_CONTACT: Record<PhoneAction, (c: PhoneContact) => boolean> = {
  'call.in': (c) => c.callIn,
  'call.out': (c) => c.callOut,
  'sms.in': (c) => c.smsIn,
  'sms.out': (c) => c.smsOut,
  'sms.reply': (c) => c.smsOut,
  'sms.read': (c) => c.smsIn,
  'conf.add': (c) => c.conf,
};

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function inQuietHours(cfg: PhoneLineConfig, now: Date): boolean {
  const start = minutesOf(cfg.limits.quietStart);
  const end = minutesOf(cfg.limits.quietEnd);
  if (start === null || end === null || start === end) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export function isValidRegularExpression(re: string): boolean {
  try { new RegExp(re); return true; } catch { return false; }
}

/** An old contact pattern (exact number, or prefix ending `*`) as a block-list regex. */
export function patternToRegex(pattern: string, countryCode: string): string | null {
  const p = pattern.trim();
  const prefix = p.endsWith('*');
  const n = normalizeNumber(prefix ? p.slice(0, -1) : p, countryCode);
  return n ? `^${n.replace('+', '\\+')}${prefix ? '' : '$'}` : null;
}

/** True when the number matches the block list, as E.164 or in national form. */
export function isBlocked(number: string, cfg: PhoneLineConfig): boolean {
  // E.164 is at most 15 digits. Longer input is refused outright, which also
  // bounds how long a badly written user regex can backtrack.
  if (number.length > 16) return true;
  const national = number.startsWith(cfg.countryCode) ? `0${number.slice(cfg.countryCode.length)}` : null;
  return cfg.blocklist.some((re) => {
    const rx = new RegExp(re);
    return rx.test(number) || (national !== null && rx.test(national));
  });
}

/** Premium-rate ranges that settings cannot unblock. */
const BUILT_IN_PREMIUM: Record<string, string[] | undefined> = { '+61': ['+6119'] };

/**
 * Numbers that cost money are refused for everyone, the owner included: a
 * talked-into-it assistant must not be able to run up a bill. International is
 * anything outside the home country code; `0011` is the Australian exit prefix,
 * which `normalizeNumber` would otherwise read as a national number.
 */
function costBlock(rawNumber: string, number: string, cfg: PhoneLineConfig): string | null {
  // Premium ranges are only known for these countries; anything else (or a
  // typo such as "+6") would make the checks meaningless, so fail closed.
  if (!BUILT_IN_PREMIUM[cfg.countryCode]) return 'outbound needs a supported country code setting (+61)';
  if (/^\s*0011/.test(rawNumber) || !number.startsWith(cfg.countryCode)) return 'international numbers are blocked';
  const premium = BUILT_IN_PREMIUM[cfg.countryCode]!.some((p) => {
    const prefix = normalizeNumber(p.replace(/\*$/, ''), cfg.countryCode);
    return prefix !== null && number.startsWith(prefix);
  });
  return premium ? 'premium numbers are blocked' : null;
}

/**
 * Dial-out on request: any number goes for a PIN-verified caller or owner-
 * authorized client, never a costly number, and within the concurrency/hourly caps.
 * A blocked entry still wins.
 */
export function decideDialOut(
  rawNumber: string, cfg: PhoneLineConfig,
  ctx: { verified: boolean; ownerAuthorized?: boolean; callsLastHour: number; activeCalls?: number },
): { allow: true; number: string } | { allow: false; reason: string } {
  if (!cfg.masters.callOut) return { allow: false, reason: 'call.out is switched off' };
  if (!ctx.verified && !ctx.ownerAuthorized) return { allow: false, reason: 'only a caller who entered their PIN can dial out' };
  const number = normalizeNumber(rawNumber, cfg.countryCode);
  if (!number) return { allow: false, reason: 'withheld or invalid number' };
  const cost = costBlock(rawNumber, number, cfg);
  if (cost) return { allow: false, reason: cost };
  if (isBlocked(number, cfg)) return { allow: false, reason: 'blocked' };
  if ((ctx.activeCalls ?? 0) >= 1) return { allow: false, reason: 'an active outbound call is already running' };
  if (ctx.callsLastHour >= cfg.limits.callsPerHour) return { allow: false, reason: 'hourly call limit reached' };
  return { allow: true, number };
}

/** Every phone action is allowed or denied here, in a fixed order. */
export function decide(action: PhoneAction, rawNumber: string, cfg: PhoneLineConfig, ctx: DecideContext): Decision {
  if (!MASTER[action](cfg.masters)) return { allow: false, reason: `${action} is switched off` };
  const number = normalizeNumber(rawNumber, cfg.countryCode);
  if (!number) return { allow: false, reason: 'withheld or invalid number' };
  if (isBlocked(number, cfg)) return { allow: false, reason: 'blocked' };
  const matches = matchContacts(number, cfg);
  const contact = matches[0]?.contact;
  if (!contact) return { allow: false, reason: 'not listed' };
  if (!PER_CONTACT[action](contact)) return { allow: false, reason: `${action} is off for ${contact.label || 'this number'}` };

  const smsOutbound = action === 'sms.out' || action === 'sms.reply';
  const outbound = action === 'call.out' || smsOutbound || action === 'conf.add';
  if (outbound) {
    const cost = costBlock(rawNumber, number, cfg);
    if (cost) return { allow: false, reason: cost };
    if (inQuietHours(cfg, ctx.now) && !(ctx.urgent && contact.role === 'owner')) return { allow: false, reason: 'quiet hours' };
    if (!smsOutbound && ctx.callsLastHour >= cfg.limits.callsPerHour) return { allow: false, reason: 'hourly call limit reached' };
    if (smsOutbound && ctx.smsLastHour >= cfg.limits.smsPerHour) return { allow: false, reason: 'hourly SMS limit reached' };
  }
  if (action === 'conf.add' && (ctx.participants ?? 2) >= cfg.conference.maxParticipants) {
    return { allow: false, reason: 'conference is full' };
  }
  return { allow: true, contact, number };
}

/** Internal policy for an explicitly authorized reply to an unlisted inbound SMS. */
export function decideSmsReply(rawNumber: string, cfg: PhoneLineConfig, ctx: DecideContext): Decision {
  if (!cfg.masters.smsOut) return { allow: false, reason: 'sms.reply is switched off' };
  const number = normalizeNumber(rawNumber, cfg.countryCode);
  if (!number) return { allow: false, reason: 'withheld or invalid number' };
  if (isBlocked(number, cfg)) return { allow: false, reason: 'blocked' };
  const cost = costBlock(rawNumber, number, cfg);
  if (cost) return { allow: false, reason: cost };
  if (inQuietHours(cfg, ctx.now)) return { allow: false, reason: 'quiet hours' };
  if (ctx.smsLastHour >= cfg.limits.smsPerHour) return { allow: false, reason: 'hourly SMS limit reached' };
  return {
    allow: true,
    number,
    contact: {
      label: 'Unknown sender', pattern: number, role: 'trusted',
      callIn: false, callOut: false, smsIn: false, smsOut: false, conf: false, pin: '', messages: false,
    },
  };
}

/** Fill `{token}` placeholders; unknown tokens are left as-is. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? values[key] : all)).replace(/\s+/g, ' ').trim();
}

/** OTP-looking codes (4–8 digits standing alone) masked, for inbox reads. */
export function maskOtp(text: string): string {
  return text.replace(/\b\d{4,8}\b/g, (d) => '•'.repeat(d.length));
}
