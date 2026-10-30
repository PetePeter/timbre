import { normalizeNumber } from './phone-config.js';

export const SMS_AUTO_REPLY_COOLDOWN_MS = 30 * 60_000;
export const SMS_AUTO_REPLY_COOLDOWN_MAX_SENDERS = 1_000;

/** Returns the normalized destination only when it is safe for an automatic reply. */
export function getReplyableSmsNumber(sender: string, ownNumber: string, countryCode: string): string | null {
  if (/\p{L}/u.test(sender)) return null;
  const digits = sender.replace(/\D/g, '');
  if (digits.length >= 1 && digits.length <= 6) return null;
  const own = normalizeNumber(ownNumber, countryCode);
  const number = normalizeNumber(sender, countryCode);
  return own && number && number !== own ? number : null;
}

/** Per-phone sender cooldown. Expired entries are removed before each reservation. */
export class SmsAutoReplyCooldown {
  private readonly senders = new Map<string, number>();

  constructor(
    private readonly cooldownMs = 30 * 60_000,
    private readonly maxSenders = 1_000,
  ) {}

  get size(): number { return this.senders.size; }

  tryReserve(sender: string, now: number): boolean {
    this.prune(now);
    const expiresAt = this.senders.get(sender);
    if (expiresAt !== undefined && expiresAt > now) return false;
    if (this.senders.size >= Math.max(1, this.maxSenders)) return false;
    this.senders.set(sender, now + Math.max(0, this.cooldownMs));
    return true;
  }

  prune(now: number): void {
    for (const [sender, expiresAt] of this.senders) if (expiresAt <= now) this.senders.delete(sender);
  }

  release(sender: string): void { this.senders.delete(sender); }
}

export interface SmsAutoReplyAuthorization {
  /** The action path must ignore any other destination and send only to this inbound sender. */
  sourceNumber: string;
  /** True only when an explicit default rule opted an unlisted sender into replies. */
  allowUnknown: boolean;
}

export interface PhoneSmsActionRequest {
  to: string;
  text: string;
  interactionId?: string;
  clientName?: string;
  autoReply?: SmsAutoReplyAuthorization;
}
