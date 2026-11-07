const SPOKEN_DIGITS: Record<string, string> = {
  zero: '0', oh: '0', o: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
  // Speech-to-text often writes a lone spoken digit as its homophone.
  to: '2', too: '2', won: '1', for: '4', ate: '8',
};

/** Extracts one spoken or numeric PIN sequence without retaining surrounding speech. */
export function spokenPinDigits(text: string): string | null {
  const tokens = text.toLowerCase().match(/[a-z]+|\d+/g) ?? [];
  for (let start = 0; start < tokens.length; start++) {
    const digits: string[] = [];
    for (let i = start; i < tokens.length; i++) {
      const token = tokens[i];
      if (/^\d+$/.test(token)) digits.push(...token);
      else if (SPOKEN_DIGITS[token] !== undefined) digits.push(SPOKEN_DIGITS[token]);
      else break;
    }
    if (digits.length >= 6) return digits.join('');
  }
  return null;
}

/** Speech heard during a PIN challenge, safe for the transcript: every digit or digit word becomes '#'. */
export function maskPinSpeech(text: string): string {
  return text.replace(/[a-z]+|\d/giu, (token) => (/\d/.test(token) || SPOKEN_DIGITS[token.toLowerCase()] !== undefined ? '#' : token));
}

/** Shape of a PIN utterance for the log: each digit or digit word becomes '#', any other word 'w'; punctuation stays. */
export function pinUtteranceShape(text: string): string {
  return text.toLowerCase().replace(/[a-z]+|\d/g, (token) => (/\d/.test(token) || SPOKEN_DIGITS[token] !== undefined ? '#' : 'w'));
}
