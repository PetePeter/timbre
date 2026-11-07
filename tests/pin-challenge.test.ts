import { describe, expect, it } from 'vitest';
import { maskPinSpeech, pinUtteranceShape, spokenPinDigits } from '../src/phone/pin-challenge.js';

describe('spoken caller PIN input', () => {
  it('extracts numeric or spoken digit sequences after a PIN prompt', () => {
    expect(spokenPinDigits('My PIN is 246813')).toBe('246813');
    expect(spokenPinDigits('two four six eight one three')).toBe('246813');
    expect(spokenPinDigits('my caller code: zero nine one two three four five six')).toBe('09123456');
  });

  it('reads digit homophones that speech-to-text writes as words', () => {
    // Regression: a live call heard "two" as a word and the PIN check got five digits.
    expect(spokenPinDigits('To, 1, 1, 2, 1, 1.')).toBe('211211');
    expect(spokenPinDigits('too one won for ate nine')).toBe('211489');
  });

  it('requires at least six digits and ignores ordinary speech', () => {
    expect(spokenPinDigits('The PIN is 12345')).toBeNull();
    expect(spokenPinDigits('I will call back in two days')).toBeNull();
  });

  it('logs the shape of a PIN utterance without any digit', () => {
    expect(pinUtteranceShape('Is 1, 1, 2 one 11.')).toBe('w #, #, # # ##.');
    expect(pinUtteranceShape('My PIN is 211211')).not.toMatch(/\d|one|two/u);
  });

  it('keeps caller speech while masking numeric and spoken PIN digits', () => {
    expect(maskPinSpeech('My PIN is four oh two six; call me on 0412345678.'))
      .toBe('My PIN is # # # #; call me on ##########.');
    expect(maskPinSpeech('To, too, won, for, ate.')).toBe('#, #, #, #, #.');
  });
});
