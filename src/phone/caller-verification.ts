import { MAX_PIN_ATTEMPTS } from './sms-pin-auth.js';
import { maskPinSpeech, pinUtteranceShape, spokenPinDigits } from './pin-challenge.js';

const PIN_CHALLENGE_MS = 30_000;
/** PINs have no maximum length; this only bounds what a caller can make Timbre buffer. */
const MAX_PIN_KEYS = 256;

type PinFailureReason = 'incorrect_pin' | 'invalid_pin' | 'timeout';
type PinChallenge = { contactId: string; resolve: (result: string) => void; timer?: NodeJS.Timeout };

interface CallerVerificationDependencies {
  contactId?: string;
  role: string;
  isCurrentCall: () => boolean;
  hasCallerPin?: (contactId: string) => boolean;
  verifyCallerPin?: (contactId: string, pin: string) => boolean;
  clock: {
    setTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimeout: (timer: NodeJS.Timeout) => void;
  };
  say: (text: string) => Promise<void>;
  recordPolicy: (allowed: boolean, details: { attempt: number; reason: string; lockedOut: boolean }) => void;
  recordUtterance: (text: string) => void;
  log: (message: string) => void;
  onVerified: () => Promise<void>;
}

/** Owns one call's caller PIN challenge, retry, keypad, and speech-redaction state. */
export class CallerVerification {
  private digits = '';
  private submitted = false;
  private tries = 0;
  private verified = false;
  private challenge?: PinChallenge;
  private transcriptMustUseRedactedRecord = false;
  private gateActive = false;
  private gate?: Promise<string>;
  private pendingGateSpeech: string[] = [];

  constructor(private readonly deps: CallerVerificationDependencies) {}

  get isVerified(): boolean { return this.verified; }
  get needsRedactedTranscript(): boolean { return this.transcriptMustUseRedactedRecord; }
  get hasPendingGateSpeech(): boolean { return this.pendingGateSpeech.length > 0; }

  /** Selects the gate only for known callers on the standard agent-bound route. */
  inboundGate(options: {
    direction: 'inbound' | 'outbound';
    action?: string;
    spamRiskScore?: number;
    hasReception: boolean;
  }): 'challenge' | 'message' | 'none' {
    if (options.direction !== 'inbound' || options.action !== 'standard' || this.verified
      || options.spamRiskScore !== undefined || options.hasReception) return 'none';
    const contactId = this.deps.contactId;
    if (!contactId || (this.deps.role !== 'owner' && this.deps.role !== 'trusted')) return 'none';
    return this.hasConfiguredPin(contactId) ? 'challenge' : 'message';
  }

  beginGate(): void { this.gateActive = true; }

  setGatePromise(gate: Promise<string>): void { this.gate = gate; }

  finishGate(): void {
    this.pendingGateSpeech = [];
    this.gateActive = false;
  }

  takePendingGateSpeech(): string | undefined { return this.pendingGateSpeech.shift(); }

  /** Starts the challenge, consuming a keypad sequence submitted before the prompt. */
  async verify(): Promise<string> {
    if (this.verified) return 'Caller is already verified.';
    if (this.tries >= MAX_PIN_ATTEMPTS) return 'Caller verification is locked for this call.';
    if (this.challenge) return this.gate ?? 'A caller PIN challenge is already active.';

    const contactId = this.deps.contactId;
    if (!contactId || !this.hasConfiguredPin(contactId)
      || (this.deps.role !== 'owner' && this.deps.role !== 'trusted')) {
      this.deps.recordPolicy(false, { attempt: 0, reason: 'pin_not_configured', lockedOut: false });
      this.deps.log('caller verification unavailable: no PIN is configured');
      return 'Caller PIN is not configured for this contact.';
    }

    this.transcriptMustUseRedactedRecord = true;
    const submittedDigits = this.submitted ? this.digits : null;
    if (submittedDigits !== null) this.clearKeypad();
    const result = new Promise<string>((resolve) => {
      this.challenge = { contactId, resolve };
      this.armTimeout();
    });
    if (submittedDigits !== null) {
      void this.checkPin(submittedDigits);
    } else {
      await this.deps.say('Please enter your caller PIN on the keypad or say the digits.').catch(() => {
        this.deps.log('caller verification prompt could not be spoken');
        this.finishChallenge('Caller verification could not start.');
      });
    }
    return result;
  }

  /** Buffers inbound DTMF that arrives before verify() opens the prompt. */
  async onDtmf(digit: string, canBuffer: boolean): Promise<void> {
    if (!this.deps.isCurrentCall() || this.verified || this.tries >= MAX_PIN_ATTEMPTS) return;
    if (!this.challenge && !canBuffer) return;
    if (digit === '#') {
      if (!this.challenge) {
        if (this.digits) this.submitted = true;
        return;
      }
      const entered = this.digits;
      this.clearKeypad();
      this.deps.log(`caller PIN keypad entry: ${entered.length} digits`);
      await this.checkPin(entered);
      return;
    }
    if (digit === '*') {
      this.clearKeypad();
      return;
    }
    if (/^[0-9]$/.test(digit) && this.digits.length < MAX_PIN_KEYS) {
      if (!this.challenge && this.submitted) this.clearKeypad();
      this.digits += digit;
    }
  }

  /** Captures challenge speech safely, or queues verified gate speech for post-briefing delivery. */
  async onUtterance(text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (this.challenge && !this.verified) {
      this.deps.recordUtterance(maskPinSpeech(trimmed));
      const digits = spokenPinDigits(text);
      this.deps.log(`caller PIN speech heard as "${pinUtteranceShape(text)}"; candidate ${digits?.length ?? 0} digits`);
      if (!digits) {
        await this.deps.say('Please say at least six PIN digits, or enter them on the keypad.');
        return true;
      }
      await this.checkPin(digits);
      return true;
    }
    if (!this.gateActive) return false;
    const heard = this.verified ? trimmed : maskPinSpeech(trimmed);
    this.deps.recordUtterance(heard);
    if (this.verified) this.pendingGateSpeech.push(heard);
    return true;
  }

  /** Ends any pending challenge and erases buffered digits when its call ends. */
  close(result: string): void {
    this.finishChallenge(result);
    this.clearKeypad();
    this.finishGate();
    this.gate = undefined;
  }

  private hasConfiguredPin(contactId: string): boolean {
    try { return !!this.deps.hasCallerPin?.(contactId); }
    catch {
      this.deps.log('caller PIN store could not be read');
      return false;
    }
  }

  private armTimeout(): void {
    const challenge = this.challenge;
    if (!challenge) return;
    if (challenge.timer) this.deps.clock.clearTimeout(challenge.timer);
    challenge.timer = this.deps.clock.setTimeout(() => { void this.fail('timeout'); }, PIN_CHALLENGE_MS);
    challenge.timer.unref?.();
  }

  private async checkPin(pin: string): Promise<void> {
    const challenge = this.challenge;
    if (!challenge || !this.deps.isCurrentCall()) return;
    if (challenge.timer) this.deps.clock.clearTimeout(challenge.timer);
    let verified = false;
    try { verified = !!this.deps.verifyCallerPin?.(challenge.contactId, pin); }
    catch { this.deps.log('caller PIN store verification failed'); }
    if (!verified) return this.fail(/^\d{6,}$/.test(pin) ? 'incorrect_pin' : 'invalid_pin');

    this.verified = true;
    this.deps.recordPolicy(true, { attempt: this.tries + 1, reason: 'verified', lockedOut: false });
    this.deps.log('caller verification passed');
    await this.deps.say('Caller verified.').catch(() => undefined);
    this.finishChallenge('Caller verified.');
    if (!this.gate) await this.deps.onVerified();
  }

  private async fail(reason: PinFailureReason): Promise<void> {
    const challenge = this.challenge;
    if (!challenge || !this.deps.isCurrentCall()) return;
    if (challenge.timer) this.deps.clock.clearTimeout(challenge.timer);
    this.clearKeypad();
    this.tries += 1;
    const lockedOut = this.tries >= MAX_PIN_ATTEMPTS;
    this.deps.recordPolicy(false, { attempt: this.tries, reason, lockedOut });
    this.deps.log(lockedOut ? 'caller verification locked after three failed attempts' : 'caller verification failed');
    if (lockedOut) {
      await this.deps.say('Caller verification is locked for this call.').catch(() => undefined);
      this.finishChallenge('Caller verification locked after three failed attempts.');
      return;
    }
    this.armTimeout();
    await this.deps.say(reason === 'timeout'
      ? 'I did not get a PIN. Please say or key it now.'
      : 'That PIN did not match. Please try again.').catch(() => undefined);
  }

  private finishChallenge(result: string): void {
    const challenge = this.challenge;
    if (!challenge) return;
    if (challenge.timer) this.deps.clock.clearTimeout(challenge.timer);
    this.challenge = undefined;
    this.clearKeypad();
    challenge.resolve(result);
  }

  private clearKeypad(): void {
    this.digits = '';
    this.submitted = false;
  }
}
