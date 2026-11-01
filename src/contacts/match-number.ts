/** Digits compared when a number has no exact match, so +61 409… and 0409… find the same contact. */
export const SUFFIX_MATCH_DIGITS = 9;

function suffix(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= SUFFIX_MATCH_DIGITS ? digits.slice(-SUFFIX_MATCH_DIGITS) : null;
}

/** Exact normalized matches win; otherwise the contacts whose numbers share the last 9 digits. */
export function matchContactsByNumber<T extends { numbers: string[] }>(contacts: T[], raw: string, normalized: string | null): T[] {
  if (normalized) {
    const exact = contacts.filter((contact) => contact.numbers.includes(normalized));
    if (exact.length) return exact;
  }
  const tail = suffix(raw);
  if (!tail) return [];
  return contacts.filter((contact) => contact.numbers.some((number) => suffix(number) === tail));
}
