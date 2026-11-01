export const MAX_PIN_ATTEMPTS = 3;
export const SMS_PIN_LOCKOUT_MS = 15 * 60_000;
export const MAX_SMS_PIN_LOCKOUT_MS = 24 * 60 * 60_000;
export const SMS_ACTION_CONTEXT_TTL_MS = 5 * 60_000;
/** MCP requests do not carry a trusted agent-turn context, so allow one brief, one-use authorization. */
export const SMS_MCP_ACTION_WINDOW_MS = 60_000;
export const MAX_SMS_ACTION_CONTEXTS = 256;

export interface SmsActionAuthorization {
  allowed: boolean;
  refusal: string;
}

export interface SmsActionAuthorizationResult extends SmsActionAuthorization {
  required: boolean;
  /** Trusted source SMS selected by the bridge, never by model arguments. */
  sourceInteractionId?: string;
}

export interface SmsReplyAuthorizationResult extends SmsActionAuthorizationResult {
  /** Trusted source SMS interaction selected by the bridge, never by model arguments. */
  sourceInteractionId?: string;
  /** Safe reply target resolved by the bridge when a caller omits interactionId. */
  replyInteractionId?: string;
}

export interface StrippedSmsPin {
  text: string;
  supplied: boolean;
  pin: string | null;
}

/** Removes explicit PIN fields before an SMS body is recorded, forwarded, or delivered to an agent. */
export function stripSmsPin(text: string): StrippedSmsPin {
  const expression = /\bPIN(?:\s*[:=#-]\s*|\s+is\b\s*|\s+|)(\d+(?:[\s-]+\d+)*)\b/giu;
  const pins = [...text.matchAll(expression)].map((match) => match[1]!.replace(/\D/g, ''));
  const stripped = text
    .replace(expression, ' ')
    .replace(/[\t ]{2,}/g, ' ')
    .replace(/[\t ]+([,.;!?])/g, '$1')
    .trim();
  return { text: stripped, supplied: pins.length > 0, pin: pins.length === 1 ? pins[0]! : null };
}

/** Per-contact, in-memory SMS PIN lockout. The PIN itself is never retained. */
export class SmsPinLockout {
  private readonly failures = new Map<string, { count: number; lastAttemptAt: number; lockedUntil: number; lockoutLevel: number }>();

  constructor(
    private readonly maxFailures = MAX_PIN_ATTEMPTS,
    private readonly lockoutMs = SMS_PIN_LOCKOUT_MS,
    private readonly maxContacts = 1_000,
  ) {}

  isLocked(contactId: string, now: number): boolean {
    const entry = this.failures.get(contactId);
    if (!entry) return false;
    if (entry.lockedUntil > now) return true;
    if (entry.lockedUntil > 0) {
      entry.count = 0;
      entry.lastAttemptAt = 0;
      entry.lockedUntil = 0;
    }
    return false;
  }

  recordFailure(contactId: string, now: number): boolean {
    const current = this.failures.get(contactId);
    const count = current && current.count > 0 && now - current.lastAttemptAt < Math.max(0, this.lockoutMs)
      ? current.count + 1
      : 1;
    const locked = count >= Math.max(1, this.maxFailures);
    const lockoutLevel = current?.lockoutLevel ?? 0;
    const nextLockoutLevel = locked ? lockoutLevel + 1 : lockoutLevel;
    const duration = locked
      ? Math.min(Math.max(0, this.lockoutMs) * 2 ** lockoutLevel, MAX_SMS_PIN_LOCKOUT_MS)
      : 0;
    this.failures.delete(contactId);
    this.failures.set(contactId, {
      count, lastAttemptAt: now, lockedUntil: locked ? now + duration : 0, lockoutLevel: nextLockoutLevel,
    });
    while (this.failures.size > Math.max(1, this.maxContacts)) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
    return locked;
  }

  reset(contactId: string): void { this.failures.delete(contactId); }

}
