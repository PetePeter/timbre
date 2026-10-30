const EXAMPLE_LINE_NUMBER = '+61400000000';
const PHONE_FORMAT_CHARACTERS = /[\s().-]/g;
const DIALABLE_LINE_NUMBER = /^\+?\d{3,32}$/;
const VALID_PIN = /^\d{6,}$/;

export interface PinDialString {
  dialString: string;
  usesExampleNumber: boolean;
}

export class PinDialStringBuilder {
  build(lineNumber: string | undefined, pin: string): PinDialString {
    if (!VALID_PIN.test(pin)) throw new Error('Caller PIN must contain at least six digits.');

    const normalizedNumber = lineNumber?.trim().replace(PHONE_FORMAT_CHARACTERS, '') ?? '';
    const usesExampleNumber = !DIALABLE_LINE_NUMBER.test(normalizedNumber);
    const targetNumber = usesExampleNumber ? EXAMPLE_LINE_NUMBER : normalizedNumber;
    return { dialString: `${targetNumber},,${pin}#`, usesExampleNumber };
  }
}
