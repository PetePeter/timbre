import { describe, expect, it } from 'vitest';
import { nextRestart } from '../src/util/restart-policy.js';

describe('nextRestart', () => {
  it('doubles delay from the base and caps it', () => {
    expect(nextRestart(0)).toEqual({ attempt: 1, delayMs: 1000 });
    expect(nextRestart(1)).toEqual({ attempt: 2, delayMs: 2000 });
    expect(nextRestart(2, { baseDelayMs: 100, maxDelayMs: 250, maxRestarts: 5 }))
      .toEqual({ attempt: 3, delayMs: 250 });
  });

  it('returns no retry after the configured limit', () => {
    expect(nextRestart(2, { maxRestarts: 2 })).toBeNull();
  });
});
