export const CONTACT_PIN_MIN_DIGITS = 6;
export const CONTACT_PIN_ERROR = 'PIN must contain at least six digits.';

/** Empty PINs leave the contact PIN unchanged; a supplied PIN is digits only. */
export function contactPinValidationError(pin: unknown): string | null {
  if (pin === undefined || pin === '') return null;
  return typeof pin === 'string' && new RegExp(`^\\d{${CONTACT_PIN_MIN_DIGITS},}$`).test(pin)
    ? null
    : CONTACT_PIN_ERROR;
}
