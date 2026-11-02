import { contactPinValidationError } from '../src/contacts/contact-validation.js';
import { normalizeAddressBookNumber } from '../src/contacts/normalize-number.js';
import { isValidRegularExpression, isValidRetentionDays, isValidSpamThreshold, normalizeNumber, patternToRegex } from '../src/phone/phone-config.js';
import { isValidDailyTokenLimit } from '../src/config/llm-validation.js';
import { isClockTime, isTimeZone } from '../src/phone/schedule.js';
import { SMS_AUTO_REPLY_MAX_LENGTH } from '../src/phone/sms-auto-reply-policy.js';
import { SMS_AUTO_REPLY_COOLDOWN_MS } from '../src/phone/sms-auto-reply.js';
import { localDateRangeToUtc } from './record-date-range.js';

export { contactPinValidationError };
export const smsAutoReplyHint = `Fixed SMS replies are limited to ${SMS_AUTO_REPLY_MAX_LENGTH} characters; automatic replies send at most once per sender every ${SMS_AUTO_REPLY_COOLDOWN_MS / 60_000} minutes.`;

export function contactNumbersError(value: unknown, countryCode: string): string | null {
  const numbers = typeof value === 'string' ? value.split(/\r?\n/).map((number) => number.trim()).filter(Boolean) : [];
  if (!numbers.length) return 'At least one phone number is required.';
  try {
    numbers.forEach((number) => normalizeAddressBookNumber(number, countryCode));
    return null;
  } catch {
    return 'Enter a valid phone number with no more than 15 digits.';
  }
}

export function phoneNumberError(value: unknown, countryCode: string, required = false): string | null {
  const number = typeof value === 'string' ? value.trim() : '';
  if (!number) return required ? 'Enter a phone number.' : null;
  return normalizeNumber(number, countryCode)
    ? null
    : 'Enter a phone number with at least three digits; spaces, hyphens, periods, and parentheses are allowed.';
}

export function phonePatternError(value: unknown, countryCode: string): string | null {
  if (typeof value === 'string' && !value.trim()) return null;
  return typeof value === 'string' && patternToRegex(value, countryCode)
    ? null
    : 'Enter a valid phone number or a prefix ending in *.';
}

export function appTokenNameError(value: unknown): string | null {
  return typeof value === 'string' && !!value.trim() && value.length <= 80
    ? null
    : 'Token name must be 1 to 80 characters.';
}

export function testCallerNumberError(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length >= 3 && value.length <= 32
    ? null
    : 'Caller number must be 3 to 32 characters.';
}

export function testCallTextError(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length >= 1 && value.length <= 4_000
    ? null
    : 'Message must contain 1 to 4000 characters.';
}

export function callDestinationError(value: unknown): string | null {
  return typeof value === 'string' && !!value.trim() && value.trim().length <= 120
    ? null
    : 'Enter a destination or contact name (up to 120 characters).';
}

export function callTaskError(value: unknown): string | null {
  return typeof value === 'string' && !!value.trim() && value.trim().length <= 4_000
    ? null
    : 'Task must contain 1 to 4000 characters.';
}

export function appTokenActionsError(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return 'Choose at least one valid action.';
  return value.includes('calls.conference') && !(value.includes('calls.receive') && value.includes('calls.make'))
    ? 'Conference calls need Receive calls and Make calls.'
    : null;
}

export function dailyTokenLimitError(value: unknown): string | null {
  return isValidDailyTokenLimit(value) ? null : 'Daily token limit must be a finite number of 0 or more.';
}

export function requiredCommandError(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? null : 'Command is required.';
}

export function retentionDaysError(value: unknown): string | null {
  return isValidRetentionDays(value) ? null : 'Retention days must be a finite number of 0 or more; invalid values use the default.';
}

export function spamThresholdError(value: unknown): string | null {
  return isValidSpamThreshold(value) ? null : 'Spam score threshold must be an integer from 0 to 100.';
}

export function blocklistPatternError(value: unknown): string | null {
  if (typeof value !== 'string') return 'Block list entries must be valid JavaScript regular expressions.';
  return value.split(/\r?\n/).some((pattern) => pattern.trim() && !isValidRegularExpression(pattern))
    ? 'Block list entries must be valid JavaScript regular expressions.'
    : null;
}

export function smsReplyError(value: unknown): string | null {
  return typeof value === 'string' && value.length <= SMS_AUTO_REPLY_MAX_LENGTH
    ? null
    : `Fixed SMS replies are limited to ${SMS_AUTO_REPLY_MAX_LENGTH} characters.`;
}

export function backupPassphraseError(value: unknown, required: boolean): string | null {
  const passphrase = typeof value === 'string' ? value : '';
  if (required && passphrase.length < 8) return 'A passphrase between 8 and 1024 characters is required to include secrets.';
  return passphrase.length > 1_024 ? 'Backup passphrase is longer than 1024 characters.' : null;
}

export function httpUrlError(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? null
      : 'Enter an absolute http:// or https:// URL.';
  } catch {
    return 'Enter an absolute http:// or https:// URL.';
  }
}

export function mcpUrlError(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'Server URL is required for HTTP transport.';
  return httpUrlError(value);
}

export function mcpServerNameError(value: unknown, existingNames: string[] = []): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    return 'Server name must start with a letter or digit and use only letters, digits, ., _, or -.';
  }
  return existingNames.includes(name) ? 'Server names must be unique.' : null;
}

export function requiredMcpCommandError(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? null : 'Command is required for stdio transport.';
}

export function piperModelPathError(value: unknown): string | null {
  const path = typeof value === 'string' ? value.trim() : '';
  if (!path) return null;
  if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path)) return 'Piper model path must be absolute.';
  return /\.onnx$/i.test(path) ? null : 'Piper model must be an .onnx file.';
}

export function timeZoneError(value: unknown): string | null {
  return typeof value === 'string' && isTimeZone(value)
    ? null
    : 'Enter a valid IANA time zone, such as Australia/Sydney.';
}

export function scheduleTimeError(value: unknown): string | null {
  return typeof value === 'string' && isClockTime(value)
    ? null
    : 'Enter a time from 00:00 to 23:59.';
}

export function dateRangeFieldError(value: unknown, other: unknown, isStart: boolean): string | null {
  if (typeof value !== 'string' || typeof other !== 'string') return 'Enter a valid date.';
  try {
    localDateRangeToUtc(isStart ? value : other, isStart ? other : value);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export function phoneSetupExecutableError(value: unknown): string | null {
  const executable = typeof value === 'string' ? value.trim() : '';
  return executable ? null : 'Choose an existing executable file.';
}
