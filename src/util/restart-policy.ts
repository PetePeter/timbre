/** Shared capped exponential retry policy for supervised child processes. */
export interface RestartPolicyOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRestarts?: number;
}

export interface RestartDecision {
  attempt: number;
  delayMs: number;
}

/** Return the next retry decision, or null once the retry limit is reached. */
export function nextRestart(attempt: number, options: RestartPolicyOptions = {}): RestartDecision | null {
  const maxRestarts = options.maxRestarts ?? 10;
  if (attempt >= maxRestarts) return null;
  return {
    attempt: attempt + 1,
    delayMs: Math.min((options.baseDelayMs ?? 1000) * 2 ** attempt, options.maxDelayMs ?? 60_000),
  };
}
