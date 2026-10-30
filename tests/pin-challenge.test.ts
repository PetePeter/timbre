import { describe, expect, it } from 'vitest';
import { spokenPinDigits } from '../src/phone/pin-challenge.js';

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
});
