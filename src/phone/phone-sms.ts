import type { ChatOutboundMessage, ChatSendResult } from '../session/chat/chat-bridge.js';
import type { SmsConversationContext } from '../agents/phone-agent.js';
import type { AddressBookContact } from '../contacts/contact.js';
import type { RecordEventKind, RecordEventType } from '../records/event-types.js';
import { resolveInboundHandling } from './inbound-call-policy.js';
import {
  MAX_SMS_ACTION_CONTEXTS, SMS_ACTION_CONTEXT_TTL_MS, SMS_MCP_ACTION_WINDOW_MS,
  SmsPinLockout, stripSmsPin, type SmsActionAuthorization, type SmsActionAuthorizationResult, type SmsReplyAuthorizationResult,
} from './sms-pin-auth.js';
import {
  maskOtp, normalizeNumber, ownerContact, type Decision, type PhoneContact, type PhoneLineConfig,
} from './phone-config.js';
import {
  getReplyableSmsNumber, SMS_AUTO_REPLY_COOLDOWN_MS, SmsAutoReplyCooldown,
  type PhoneSmsActionRequest, type SmsAutoReplyAuthorization,
} from './sms-auto-reply.js';
import type { SmsAutoReplyPolicy } from './sms-auto-reply-policy.js';

const SMS_REPLY_WINDOW_MS = SMS_AUTO_REPLY_COOLDOWN_MS;

function unknownSmsContact(number: string): PhoneContact {
  return {
    label: 'Unknown sender', pattern: number, role: 'trusted',
    callIn: false, callOut: false, smsIn: false, smsOut: false, conf: false, pin: '', messages: false,
  };
}

export interface PhoneSmsClient {
  isConnected(): boolean;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** Shared by PhoneLineService so duplicate detection and policy state survive bridge rebuilds. */
export interface SmsMemory {
  seen: Set<string>;
  received: Set<string>;
  primed: boolean;
  autoReplyCooldown?: SmsAutoReplyCooldown;
  pinLockout?: SmsPinLockout;
}

interface SmsSummary { handle: string; number: string; preview: string; ts: string }
interface PendingSmsReply {
  contact: PhoneContact;
  sessionId: string;
  at: number;
  interactionId: string;
  autoReply: SmsAutoReplyAuthorization;
}
interface PendingSmsActionContext {
  sessionId: string;
  contact: PhoneContact;
  sourceNumber: string;
  allowUnknown: boolean;
  at: number;
  authorization: SmsActionAuthorization;
  refusalSent: boolean;
  mcpActionConsumed: boolean;
}

export interface PhoneSmsReception {
  onSmsFrom(contact: PhoneContact, text: string): Promise<boolean>;
}

/** Callbacks keep phone policy, recording, and delivery owned by PhoneBridge. */
export interface PhoneSmsPort {
  client: PhoneSmsClient;
  memory: SmsMemory;
  getConfig: () => PhoneLineConfig;
  getOperatorId: () => string | null;
  now: () => Date;
  interactionId: () => string;
  checkInbound: (number: string, interactionId: string, beforePolicy: (decision: Decision) => void) => Decision;
  checkOutbound: (number: string, interactionId: string) => Decision;
  checkRead: (number: string, config: PhoneLineConfig) => Decision;
  checkReply: (number: string, interactionId: string) => Decision;
  lookupAddressBook: (number?: string) => AddressBookContact[];
  isStrangerReason: (reason: string) => boolean;
  hasCallerPin?: (contactId: string) => boolean;
  verifyCallerPin?: (contactId: string, pin: string) => boolean;
  deliver: (sessionId: string, text: string, context?: SmsConversationContext) => Promise<void>;
  sendSmsAction?: (request: PhoneSmsActionRequest) => Promise<ChatSendResult>;
  isTestCallActive?: () => boolean;
  getReception: () => PhoneSmsReception | null;
  isCallSession: (sessionId: string) => boolean;
  isVerifiedCaller: (sessionId?: string) => boolean;
  findContact: (name: string) => PhoneContact | null;
  record: (interactionId: string, kind: RecordEventKind, type: RecordEventType, details: Record<string, unknown>, occurredAt?: string) => void;
  recordAddressBookMatches: (interactionId: string, number: string) => void;
  log: (message: string) => void;
  emitStatus: () => void;
  untrusted: (text: string) => string;
  signature: (cfg: PhoneLineConfig) => string;
}

/** Owns SMS conversation routing, authorization contexts, and shared SMS policy state. */
export class PhoneSms {
  private readonly memory: SmsMemory;
  private readonly pendingReplies = new Map<string, PendingSmsReply>();
  private readonly actionContexts = new Map<string, PendingSmsActionContext>();
  private readonly pinLockout: SmsPinLockout;
  private readonly autoReplyCooldown: SmsAutoReplyCooldown;
  private readonly outSms: number[] = [];

  constructor(private readonly port: PhoneSmsPort) {
    this.memory = port.memory;
    this.autoReplyCooldown = this.memory.autoReplyCooldown ?? new SmsAutoReplyCooldown();
    this.memory.autoReplyCooldown = this.autoReplyCooldown;
    this.pinLockout = this.memory.pinLockout ?? new SmsPinLockout();
    this.memory.pinLockout = this.pinLockout;
  }

  sentLastHour(now: number): number {
    const cutoff = now - 60 * 60_000;
    while (this.outSms.length && this.outSms[0]! < cutoff) this.outSms.shift();
    return this.outSms.length;
  }

  hasReceived(handle: string): boolean { return this.memory.received.has(handle); }

  async inbox(): Promise<{ messages: Array<{ from: string; text: string; ts: string }> }> {
    const cfg = this.port.getConfig();
    if (cfg.smsRead.scope === 'none') throw new Error('Reading SMS is switched off in Settings > Phone line.');
    const { messages } = await this.port.client.request<{ messages: SmsSummary[] }>('sms.list', { limit: 50 });
    const cutoff = this.port.now().getTime() - cfg.smsRead.windowMin * 60_000;
    const out: Array<{ from: string; text: string; ts: string }> = [];
    for (const message of messages) {
      if (cfg.smsRead.scope === 'received' && !this.memory.received.has(message.handle)) continue;
      if (cfg.smsRead.scope === 'window' && !(Date.parse(message.ts) >= cutoff)) continue;
      const decision = this.port.checkRead(message.number, cfg);
      if (!decision.allow) continue;
      const text = this.port.untrusted(stripSmsPin(message.preview).text);
      out.push({ from: decision.contact.label, text: cfg.smsRead.maskOtp ? maskOtp(text) : text, ts: message.ts });
    }
    return { messages: out };
  }

  /** Returns null when this message belongs to the active-call route instead. */
  async trySendToSession(message: ChatOutboundMessage): Promise<ChatSendResult | null> {
    const now = this.port.now().getTime();
    this.prunePendingReplies(now);
    if (message.interactionId !== undefined) {
      const interactionId = message.interactionId;
      if (!interactionId.trim()) return { sent: false, reason: 'SMS reply interaction ID is required' };
      const pending = this.pendingReplies.get(interactionId);
      if (!pending || pending.sessionId !== message.sessionId) {
        return { sent: false, reason: 'no live SMS reply for this interaction' };
      }
      this.pendingReplies.delete(interactionId);
      return this.sendSmsViaAction(pending.contact, message.text, interactionId, undefined, pending.autoReply);
    }
    if ([...this.pendingReplies.values()].some((pending) => pending.sessionId === message.sessionId)) {
      return { sent: false, reason: 'SMS reply interaction ID is required' };
    }
    return null;
  }

  authorizeAction(sessionId: string, interactionId: string, consumeMcpAction = false): SmsActionAuthorizationResult {
    if (consumeMcpAction && this.port.isCallSession(sessionId)) return { required: false, allowed: true, refusal: '' };
    this.pruneActionContexts(this.port.now().getTime());
    const currentContexts = [...this.actionContexts.entries()].filter(([, item]) => item.sessionId === sessionId);
    const latest = currentContexts.at(-1);
    const sourceInteractionId = latest?.[0] ?? '';
    const context = sourceInteractionId ? this.actionContexts.get(sourceInteractionId) : undefined;
    if (context) {
      if (currentContexts.length > 1) {
        return {
          required: true, allowed: false,
          refusal: 'Multiple SMS conversations are pending. Privileged actions are refused until one message is handled at a time.',
          sourceInteractionId,
        };
      }
      if (interactionId && interactionId !== sourceInteractionId) {
        return {
          required: true, allowed: false,
          refusal: 'This SMS action must be authorized by the current SMS interaction. Include its PIN in that same SMS.',
          sourceInteractionId,
        };
      }
      const mcpWindowExpired = this.port.now().getTime() - context.at >= SMS_MCP_ACTION_WINDOW_MS;
      if (consumeMcpAction && context.authorization.allowed && (context.mcpActionConsumed || mcpWindowExpired)) {
        return {
          required: true, allowed: false,
          refusal: context.mcpActionConsumed
            ? 'This SMS PIN authorization was already used. Include the contact PIN with a new SMS for another privileged action.'
            : 'This SMS PIN authorization expired. Resend the request with the contact PIN in the same SMS.',
          sourceInteractionId,
        };
      }
      if (consumeMcpAction && context.authorization.allowed) context.mcpActionConsumed = true;
      return { required: true, ...context.authorization, sourceInteractionId };
    }
    if (interactionId.startsWith('sms:')) {
      return { required: true, allowed: false, refusal: 'This SMS action authorization expired. Resend the request with the contact PIN in the same SMS.' };
    }
    return { required: false, allowed: true, refusal: '' };
  }

  authorizeReply(sessionId: string, sourceInteractionId: string, replyInteractionId: string, consumeMcpAction = false): SmsReplyAuthorizationResult {
    if (consumeMcpAction && this.port.isCallSession(sessionId)) {
      if (!sourceInteractionId && !replyInteractionId) return { required: false, allowed: true, refusal: '' };
      if (!this.port.isVerifiedCaller()) {
        return { required: true, allowed: false, refusal: 'Caller verification is required for SMS actions during a live call.' };
      }
      return { required: false, allowed: true, refusal: '' };
    }
    this.pruneActionContexts(this.port.now().getTime());
    let sourceId = sourceInteractionId;
    if (!sourceId) {
      const currentContexts = [...this.actionContexts.entries()].filter(([, item]) => item.sessionId === sessionId);
      const latest = currentContexts.at(-1);
      sourceId = latest?.[0] ?? '';
      if (currentContexts.length > 1 && !replyInteractionId) {
        return {
          required: true, allowed: false,
          refusal: 'Multiple SMS conversations are pending. Include the interaction ID for the message you are answering.',
          sourceInteractionId: sourceId,
        };
      }
    }
    const source = sourceId ? this.actionContexts.get(sourceId) : undefined;
    if (!source) {
      if (sourceInteractionId.startsWith('sms:')) {
        return {
          required: true, allowed: false, refusal: 'This SMS reply authorization expired. Resend the request with the contact PIN in the same SMS.',
          sourceInteractionId,
        };
      }
      return { required: false, allowed: true, refusal: '' };
    }
    if (source.sessionId !== sessionId) {
      return { required: true, allowed: false, refusal: 'This SMS reply belongs to another session.', sourceInteractionId: sourceId };
    }
    const targetInteractionId = replyInteractionId || sourceId;
    const target = targetInteractionId ? this.actionContexts.get(targetInteractionId) : undefined;
    if (!targetInteractionId || !target || target.sessionId !== sessionId) {
      return {
        required: true, allowed: false,
        refusal: source.authorization.allowed
          ? 'The SMS reply target is unavailable. Reply using the interaction ID from the current SMS.'
          : source.authorization.refusal || 'Include the contact PIN in the same SMS to send a message to another number.',
        sourceInteractionId: sourceId,
      };
    }
    const cfg = this.port.getConfig();
    const sourceNumber = normalizeNumber(source.sourceNumber, cfg.countryCode);
    const targetNumber = normalizeNumber(target.sourceNumber, cfg.countryCode);
    if (sourceNumber && sourceNumber === targetNumber) {
      if (consumeMcpAction) source.mcpActionConsumed = true;
      return { required: false, allowed: true, refusal: '', sourceInteractionId: sourceId, replyInteractionId: targetInteractionId };
    }
    const mcpWindowExpired = this.port.now().getTime() - source.at >= SMS_MCP_ACTION_WINDOW_MS;
    if (consumeMcpAction && source.authorization.allowed && (source.mcpActionConsumed || mcpWindowExpired)) {
      return {
        required: true, allowed: false,
        refusal: source.mcpActionConsumed
          ? 'This SMS PIN authorization was already used. Include the contact PIN with a new SMS to message another sender.'
          : 'This SMS PIN authorization expired. Resend the request with the contact PIN in the same SMS.',
        sourceInteractionId: sourceId, replyInteractionId: targetInteractionId,
      };
    }
    if (consumeMcpAction && source.authorization.allowed) source.mcpActionConsumed = true;
    return {
      required: true,
      allowed: source.authorization.allowed,
      refusal: source.authorization.allowed
        ? ''
        : source.authorization.refusal || 'Include the contact PIN in the same SMS to send a message to another number.',
      sourceInteractionId: sourceId,
      replyInteractionId: targetInteractionId,
    };
  }

  async refuseAction(sessionId: string, interactionId: string, refusal?: string): Promise<void> {
    this.pruneActionContexts(this.port.now().getTime());
    const matching = interactionId
      ? [[interactionId, this.actionContexts.get(interactionId)] as const]
      : [...this.actionContexts.entries()].filter(([, item]) => item.sessionId === sessionId);
    const [targetInteractionId, context] = matching.length === 1 ? matching[0]! : [];
    if (!targetInteractionId || !context || context.sessionId !== sessionId || context.refusalSent) return;
    context.refusalSent = true;
    const authorization: SmsAutoReplyAuthorization = { sourceNumber: context.sourceNumber, allowUnknown: context.allowUnknown };
    const result = await this.sendSmsViaAction(
      context.contact,
      `Timbre: ${refusal ?? context.authorization.refusal}`,
      targetInteractionId,
      undefined,
      authorization,
    );
    if (!result.sent) this.port.log(`SMS action refusal reply not sent: ${result.reason ?? 'SMS action unavailable'}`);
  }

  invalidateMcpAuthorizations(sessionId: string): void {
    for (const context of this.actionContexts.values()) {
      if (context.sessionId === sessionId) context.mcpActionConsumed = true;
    }
  }

  async poll(): Promise<void> {
    if (!this.port.client.isConnected()) return;
    try {
      const { messages } = await this.port.client.request<{ messages: SmsSummary[] }>('sms.list', { limit: 20 });
      if (!this.memory.primed) {
        messages.forEach((message) => this.memory.seen.add(message.handle));
        this.memory.primed = true;
        return;
      }
      for (const message of [...messages].reverse()) await this.onSms(message);
    } catch (err) {
      this.port.log(`sms poll failed: ${(err as Error).message}`);
    }
  }

  receive(message: SmsSummary): Promise<void> { return this.onSms(message); }

  private async onSms(message: SmsSummary): Promise<void> {
    if (this.memory.seen.has(message.handle)) return;
    const operator = this.port.getOperatorId();
    const reception = this.port.getReception();
    const interactionId = `sms:${message.handle}`;
    const decision = this.port.checkInbound(message.number, interactionId, (result) => {
      const stranger = !result.allow && this.port.isStrangerReason(result.reason);
      if (operator || reception || stranger) this.port.recordAddressBookMatches(interactionId, message.number);
    });
    const stranger = !decision.allow && this.port.isStrangerReason(decision.reason);
    if (!operator && !reception && !stranger) return;
    this.memory.seen.add(message.handle);
    if (!decision.allow && !stranger) return;
    const text = await this.readText(message);
    const submittedPin = stripSmsPin(text);
    const body = submittedPin.text;
    const cfg = this.port.getConfig();
    const addressBook = this.port.lookupAddressBook(message.number);
    if (decision.allow && !decision.contact.contactId) {
      const number = normalizeNumber(message.number, cfg.countryCode);
      const matches = number
        ? addressBook.filter((contact) => contact.numbers.some((entry) => normalizeNumber(entry, cfg.countryCode) === number))
        : [];
      if (matches.length === 1) decision.contact = { ...decision.contact, contactId: matches[0]!.id };
    }
    const actionAuthorization = this.smsActionAuthorization(decision.allow ? decision.contact.contactId : undefined, submittedPin);
    this.port.record(interactionId, 'sms', 'sms.received', {
      contact: decision.allow ? decision.contact.label : 'Unknown caller',
      from: message.number,
      direction: 'inbound',
      action: 'received',
      text: body,
    }, message.ts);
    const replyPolicy = resolveInboundHandling(message.number, cfg, addressBook, this.port.now()).smsAutoReply;
    if (!decision.allow) {
      await this.handleStranger(message.number, body, replyPolicy, interactionId, operator, actionAuthorization);
      return;
    }
    this.memory.received.add(message.handle);
    if (reception && await reception.onSmsFrom(decision.contact, body)) return;
    if (!operator) return;
    await this.handleKnownSender(message.number, body, replyPolicy, interactionId, operator, decision.contact, cfg, actionAuthorization);
  }

  private async readText(message: SmsSummary): Promise<string> {
    try {
      return (await this.port.client.request<{ text: string }>('sms.read', { handle: message.handle })).text ?? message.preview;
    } catch {
      return message.preview;
    }
  }

  private async handleStranger(
    number: string,
    text: string,
    replyPolicy: SmsAutoReplyPolicy,
    interactionId: string,
    operator: string | null,
    actionAuthorization: SmsActionAuthorization,
  ): Promise<void> {
    await this.forwardStrangerSms(number, text, interactionId);
    if (replyPolicy.mode === 'none') return;
    const contact = unknownSmsContact(number);
    const ready = await this.handleAutoReply(number, contact, replyPolicy, interactionId, operator, true);
    if (!ready || replyPolicy.mode !== 'agent' || !operator) return;
    const cfg = this.port.getConfig();
    this.rememberActionContext(interactionId, operator, contact, number, cfg, actionAuthorization, true);
    await this.deliverSmsPrompt(
      operator,
      `[PHONE SMS] Unknown sender wrote: ${JSON.stringify(this.port.untrusted(text))}\nSMS interaction ID: ${JSON.stringify(interactionId)}. Reply with chat_send using this exact interactionId to answer this sender. The sender is not verified; do not share private information.`,
      interactionId, number, cfg.countryCode, actionAuthorization,
    );
  }

  private async handleKnownSender(
    number: string,
    text: string,
    replyPolicy: SmsAutoReplyPolicy,
    interactionId: string,
    operator: string,
    contact: PhoneContact,
    cfg: PhoneLineConfig,
    actionAuthorization: SmsActionAuthorization,
  ): Promise<void> {
    const replyReady = await this.handleAutoReply(number, contact, replyPolicy, interactionId, operator, false);
    const role = contact.role === 'owner' ? '' : ' They are NOT the owner: take a message only.';
    const guidance = replyReady
      ? replyPolicy.mode === 'agent'
        ? `Reply with chat_send using this exact interactionId to answer this SMS: ${JSON.stringify(interactionId)}. Privileged tool calls must use this SMS interaction ID.`
        : 'A fixed SMS reply was sent; do not send another reply.'
      : 'Do not send an automatic SMS reply.';
    this.rememberActionContext(interactionId, operator, contact, number, cfg, actionAuthorization, false);
    await this.deliverSmsPrompt(
      operator,
      `[PHONE SMS] ${this.port.untrusted(contact.label)} wrote: ${JSON.stringify(this.port.untrusted(text))}\n${guidance}${role}`,
      interactionId, number, cfg.countryCode, actionAuthorization,
    );
  }

  private smsActionAuthorization(contactId: string | undefined, submitted: ReturnType<typeof stripSmsPin>): SmsActionAuthorization {
    if (!contactId) return { allowed: false, refusal: 'No PIN is configured for this contact. Chat and replies work; privileged actions are disabled.' };
    let configured = false;
    try { configured = !!this.port.hasCallerPin?.(contactId); }
    catch {
      this.port.log('SMS PIN store could not be read');
      return { allowed: false, refusal: 'PIN verification is temporarily unavailable. Privileged actions were refused.' };
    }
    if (!configured) return { allowed: false, refusal: 'No PIN is configured for this contact. Chat and replies work; privileged actions are disabled.' };

    const now = this.port.now().getTime();
    if (this.pinLockout.isLocked(contactId, now)) {
      return { allowed: false, refusal: 'Too many incorrect PIN attempts. Privileged SMS actions are temporarily locked.' };
    }
    if (!submitted.supplied) {
      return { allowed: false, refusal: 'Include PIN: <your contact PIN> in the same SMS to authorize calls, messages to other numbers, conferences, or other tools.' };
    }
    if (!submitted.text) {
      return { allowed: false, refusal: 'The PIN must be sent with the action request in the same SMS.' };
    }
    if (!this.port.verifyCallerPin) {
      return { allowed: false, refusal: 'PIN verification is temporarily unavailable. Privileged actions were refused.' };
    }

    let verified = false;
    try { verified = submitted.pin !== null && this.port.verifyCallerPin(contactId, submitted.pin); }
    catch {
      this.port.log('SMS PIN store verification failed');
      return { allowed: false, refusal: 'PIN verification is temporarily unavailable. Privileged actions were refused.' };
    }
    if (verified) {
      this.pinLockout.reset(contactId);
      return { allowed: true, refusal: '' };
    }
    const locked = this.pinLockout.recordFailure(contactId, now);
    return {
      allowed: false,
      refusal: locked
        ? 'Too many incorrect PIN attempts. Privileged SMS actions are temporarily locked.'
        : 'The PIN was incorrect. Privileged SMS actions were refused; resend the request with PIN: <your contact PIN> in the same SMS.',
    };
  }

  private rememberActionContext(
    interactionId: string,
    sessionId: string,
    contact: PhoneContact,
    rawNumber: string,
    cfg: PhoneLineConfig,
    authorization: SmsActionAuthorization,
    allowUnknown: boolean,
  ): void {
    const now = this.port.now().getTime();
    this.pruneActionContexts(now);
    this.actionContexts.delete(interactionId);
    this.actionContexts.set(interactionId, {
      sessionId,
      contact,
      sourceNumber: getReplyableSmsNumber(rawNumber, cfg.localNumber, cfg.countryCode)
        ?? normalizeNumber(rawNumber, cfg.countryCode)
        ?? rawNumber,
      allowUnknown,
      at: now,
      authorization,
      refusalSent: false,
      mcpActionConsumed: false,
    });
    while (this.actionContexts.size > MAX_SMS_ACTION_CONTEXTS) {
      const oldest = this.actionContexts.keys().next().value;
      if (oldest === undefined) break;
      this.actionContexts.delete(oldest);
    }
  }

  private pruneActionContexts(now: number): void {
    for (const [interactionId, context] of this.actionContexts) {
      if (now - context.at >= SMS_ACTION_CONTEXT_TTL_MS) this.actionContexts.delete(interactionId);
    }
  }

  private async handleAutoReply(
    rawNumber: string,
    contact: PhoneContact,
    policy: SmsAutoReplyPolicy,
    interactionId: string,
    operator: string | null,
    allowUnknown: boolean,
  ): Promise<boolean> {
    if (policy.mode === 'none' || this.port.isTestCallActive?.()) return false;
    const cfg = this.port.getConfig();
    const number = getReplyableSmsNumber(rawNumber, cfg.localNumber, cfg.countryCode);
    if (!number || (policy.mode === 'agent' && !operator)) return false;
    if (!this.autoReplyCooldown.tryReserve(number, this.port.now().getTime())) return false;

    const authorization: SmsAutoReplyAuthorization = { sourceNumber: number, allowUnknown };
    if (policy.mode === 'fixed') {
      const result = await this.sendSmsViaAction(contact, policy.text, interactionId, undefined, authorization);
      if (!result.sent) this.autoReplyCooldown.release(number);
      return result.sent;
    }

    const now = this.port.now().getTime();
    this.prunePendingReplies(now);
    if (this.pendingReplies.has(interactionId)) {
      this.autoReplyCooldown.release(number);
      return false;
    }
    this.pendingReplies.set(interactionId, {
      contact: { ...contact, pattern: number }, sessionId: operator!, at: now, interactionId, autoReply: authorization,
    });
    return true;
  }

  private prunePendingReplies(now: number): void {
    for (const [interactionId, pending] of this.pendingReplies) {
      if (now - pending.at >= SMS_REPLY_WINDOW_MS) this.pendingReplies.delete(interactionId);
    }
  }

  private async deliverSmsPrompt(
    sessionId: string,
    prompt: string,
    interactionId: string,
    senderNumber: string,
    countryCode: string,
    actionAuthorization?: SmsActionAuthorization,
  ): Promise<void> {
    try {
      await this.port.deliver(sessionId, prompt, {
        kind: 'sms', senderNumber, countryCode, interactionId,
        ...(actionAuthorization ? {
          actionAuthorization,
          actionAuthorizationExpiresAt: this.port.now().getTime() + SMS_ACTION_CONTEXT_TTL_MS,
        } : {}),
      });
    } catch (err) {
      const pending = this.pendingReplies.get(interactionId);
      if (pending) {
        this.pendingReplies.delete(interactionId);
        this.autoReplyCooldown.release(pending.autoReply.sourceNumber);
      }
      throw err;
    }
  }

  private async forwardStrangerSms(from: string, text: string, interactionId: string): Promise<void> {
    const owner = ownerContact(this.port.getConfig());
    if (!owner) return;
    const result = await this.sendSmsViaAction(owner, `SMS from ${from || 'unknown'}: ${text}`.slice(0, 640), interactionId);
    if (!result.sent) this.port.log(`stranger SMS not forwarded: ${result.reason}`);
  }

  async sendSms(
    contact: PhoneContact,
    text: string,
    interactionId = this.port.interactionId(),
    clientName?: string,
    autoReply?: SmsAutoReplyAuthorization,
  ): Promise<ChatSendResult> {
    if (this.port.isTestCallActive?.()) return { sent: false, reason: 'SMS is disabled during a test call.' };
    let decision: Decision;
    if (autoReply) {
      const cfg = this.port.getConfig();
      const sourceNumber = getReplyableSmsNumber(autoReply.sourceNumber, cfg.localNumber, cfg.countryCode);
      const targetNumber = normalizeNumber(contact.pattern, cfg.countryCode);
      if (!sourceNumber || sourceNumber !== targetNumber) return { sent: false, reason: 'auto-reply destination mismatch' };
      decision = this.port.checkOutbound(sourceNumber, interactionId);
      if (!decision.allow && autoReply.allowUnknown && decision.reason === 'not listed') decision = this.port.checkReply(sourceNumber, interactionId);
    } else {
      decision = this.port.checkOutbound(contact.pattern, interactionId);
    }
    if (!decision.allow) return { sent: false, reason: decision.reason };
    const cfg = this.port.getConfig();
    const body = `${text}${this.port.signature(cfg)}`;
    this.outSms.push(this.port.now().getTime());
    await this.port.client.request('sms.send', { number: decision.number, text: body });
    this.port.record(interactionId, 'sms', 'sms.sent', {
      contact: decision.contact.label || contact.label, to: decision.number, direction: 'outbound', action: 'sent', text: body,
      ...(clientName ? { clientName } : {}),
    });
    this.port.emitStatus();
    return { sent: true };
  }

  async sendSmsToContact(
    sessionId: string,
    name: string,
    text: string,
    authorization?: SmsActionAuthorizationResult,
  ): Promise<ChatSendResult> {
    if (!this.port.isVerifiedCaller(sessionId) && !(authorization?.required && authorization.allowed)) {
      return { sent: false, reason: 'caller verification required' };
    }
    const contact = this.port.findContact(name);
    if (!contact) return { sent: false, reason: 'contact name not found' };
    return this.sendSms(contact, text);
  }

  sendSmsViaAction(
    contact: PhoneContact,
    text: string,
    interactionId = this.port.interactionId(),
    clientName?: string,
    autoReply?: SmsAutoReplyAuthorization,
  ): Promise<ChatSendResult> {
    if (this.port.sendSmsAction) {
      const request: PhoneSmsActionRequest = {
        to: autoReply?.sourceNumber ?? contact.pattern,
        text,
        interactionId,
        ...(clientName ? { clientName } : {}),
        ...(autoReply ? { autoReply } : {}),
      };
      return this.port.sendSmsAction(request);
    }
    return Promise.resolve({ sent: false, reason: 'shared SMS action is unavailable' });
  }
}