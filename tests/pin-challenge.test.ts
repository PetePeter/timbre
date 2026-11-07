import { describe, expect, it } from 'vitest';
import { pinUtteranceShape, spokenPinDigits } from '../src/phone/pin-challenge.js';

describe('spoken caller PIN input', () => {
  it('extracts numeric or spoken digit sequences after a PIN prompt', () => {
    expect(spokenPinDigits('My PIN is 246813')).toBe('246813');
    expect(spokenPinDigits('two four six eight one three')).toBe('246813');
    expect(spokenPinDigits('my caller code: zero nine one two three four five six')).toBe('09123456');
  });

  it('requires at least six digits and ignores ordinary speech', () => {
    expect(spokenPinDigits('The PIN is 12345')).toBeNull();
    expect(spokenPinDigits('I will call back in two days')).toBeNull();
  });

  it('logs the shape of a PIN utterance without any digit', () => {
    expect(pinUtteranceShape('To 1, 1, 2 one 11.')).toBe('w #, #, # # ##.');
    expect(pinUtteranceShape('My PIN is 211211')).not.toMatch(/\d|one|two/u);
  });
});
