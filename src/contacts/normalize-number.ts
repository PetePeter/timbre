import { normalizeNumber } from '../phone/phone-config.js';

const E164 = /^\+[1-9]\d{2,14}$/;

/** Reuse line-policy parsing while limiting address-book values to E.164's 15 digits. */
export function normalizeAddressBookNumber(raw: string, countryCode: string): string {
  const normalized = normalizeNumber(raw, countryCode);
  if (!normalized || !E164.test(normalized)) throw new Error('Enter a valid phone number with no more than 15 digits.');
  return normalized;
}
