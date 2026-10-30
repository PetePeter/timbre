export type SmsAutoReplyMode = 'none' | 'agent' | 'fixed';

export interface SmsAutoReplyPolicy {
  mode: SmsAutoReplyMode;
  text: string;
}

export const NO_SMS_AUTO_REPLY: SmsAutoReplyPolicy = { mode: 'none', text: '' };

export function normalizeSmsAutoReply(value: unknown, fallback: SmsAutoReplyPolicy = NO_SMS_AUTO_REPLY): SmsAutoReplyPolicy {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const mode = raw.mode === 'none' || raw.mode === 'agent' || raw.mode === 'fixed' ? raw.mode : fallback.mode;
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 640) : fallback.text;
  if (mode === 'fixed') return text.trim() ? { mode, text } : { ...NO_SMS_AUTO_REPLY };
  return { mode, text: '' };
}
