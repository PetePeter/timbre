import { describe, expect, it } from 'vitest';
import { PinDialStringBuilder } from './pin-dial-string-builder.js';

describe('PinDialStringBuilder', () => {
  const builder = new PinDialStringBuilder();

  it('normalizes a configured line and adds two pauses, the PIN, and its submit key', () => {
    expect(builder.build('+61 (400) 000-000', '123456')).toEqual({
      dialString: '+61400000000,,123456#',
      usesExampleNumber: false,
    });
  });

  it('uses a clearly marked example when the configured line is missing or invalid', () => {
    expect(builder.build(undefined, '123456')).toEqual({
      dialString: '+61400000000,,123456#',
      usesExampleNumber: true,
    });
    expect(builder.build('not a number', '123456').usesExampleNumber).toBe(true);
  });

  it('rejects a PIN that cannot be entered under the caller PIN rule', () => {
    expect(() => builder.build('+61400000000', '12345')).toThrow(/six digits/i);
    expect(() => builder.build('+61400000000', '12A456')).toThrow(/six digits/i);
  });
});
