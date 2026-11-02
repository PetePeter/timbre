import { describe, expect, it } from 'vitest';
import { appTokenActionsError, requiredCommandError } from './field-validation';

describe('appTokenActionsError', () => {
  it('requires Make calls for conferencing while Receive calls stays optional', () => {
    expect(appTokenActionsError(['calls.conference', 'calls.make'])).toBeNull();
    expect(appTokenActionsError(['calls.conference', 'calls.make', 'calls.receive'])).toBeNull();
    expect(appTokenActionsError(['calls.conference', 'calls.receive'])).toBe('Conference calls need Make calls.');
  });
});

describe('requiredCommandError', () => {
  it('accepts a nonblank command and rejects empty or whitespace-only input', () => {
    expect(requiredCommandError(' claude ')).toBeNull();
    expect(requiredCommandError('')).toBe('Command is required.');
    expect(requiredCommandError('   ')).toBe('Command is required.');
    expect(requiredCommandError(undefined)).toBe('Command is required.');
  });
});
