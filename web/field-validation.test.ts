import { describe, expect, it } from 'vitest';
import { requiredCommandError } from './field-validation';

describe('requiredCommandError', () => {
  it('accepts a nonblank command and rejects empty or whitespace-only input', () => {
    expect(requiredCommandError(' claude ')).toBeNull();
    expect(requiredCommandError('')).toBe('Command is required.');
    expect(requiredCommandError('   ')).toBe('Command is required.');
    expect(requiredCommandError(undefined)).toBe('Command is required.');
  });
});
