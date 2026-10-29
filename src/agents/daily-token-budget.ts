import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatClient, CompletionResult } from '../session/api/api-agent-loop.js';

interface UsageState { day: string; used: number; unknownUsage?: boolean }

/** Prevents another API completion once this phone's local-day budget is exhausted. */
export class DailyTokenBudget {
  private state: UsageState;

  constructor(
    private readonly file: string,
    private readonly limit: number,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.state = this.load();
    this.persist();
  }

  get used(): number {
    this.refreshDay();
    return this.state.used;
  }

  get isExceeded(): boolean {
    this.refreshDay();
    return this.limit > 0 && (!!this.state.unknownUsage || this.state.used >= this.limit);
  }

  /** Wraps the actual client so every completion round is accounted before another can start. */
  wrap(client: ChatClient): ChatClient {
    return {
      complete: async (...args) => {
        if (this.isExceeded) throw new TokenBudgetExceededError();
        const result = await client.complete(...args);
        this.record(result);
        return result;
      },
    };
  }

  private load(): UsageState {
    const day = localDay(this.now());
    if (!existsSync(this.file)) return { day, used: 0 };
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!isUsageState(value) || value.day > day) {
        this.log('daily API token usage state is invalid; treating usage as unknown');
        return { day, used: knownUsage(value), unknownUsage: true };
      }
      if (value.day !== day) return { day, used: 0 };
      return { day, used: value.used, ...(value.unknownUsage ? { unknownUsage: true } : {}) };
    } catch {
      // Existing usage that cannot be read is unknown, so a capped agent must stop.
      this.log('daily API token usage state could not be read; treating usage as unknown');
      return { day, used: 0, unknownUsage: this.limit > 0 };
    }
  }

  private refreshDay(): void {
    const day = localDay(this.now());
    if (this.state.day === day) return;
    this.state = { day, used: 0 };
    this.persist();
  }

  private record(result: CompletionResult): void {
    this.refreshDay();
    const usage = result.usage;
    const hasParts = typeof usage?.prompt_tokens === 'number' || typeof usage?.completion_tokens === 'number';
    const tokens = typeof usage?.total_tokens === 'number'
      ? usage.total_tokens
      : hasParts ? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0) : undefined;
    if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) {
      this.state.unknownUsage = true;
    } else {
      this.state.used += Math.floor(tokens);
    }
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.state), 'utf8');
    } catch {
      this.state.unknownUsage = true;
    }
  }
}

export class TokenBudgetExceededError extends Error {
  constructor() {
    super('Daily API token limit reached.');
    this.name = 'TokenBudgetExceededError';
  }
}

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isUsageState(value: unknown): value is UsageState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return isLocalDay(state.day)
    && typeof state.used === 'number' && Number.isSafeInteger(state.used) && state.used >= 0
    && (state.unknownUsage === undefined || typeof state.unknownUsage === 'boolean');
}

function isLocalDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1000) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function knownUsage(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const used = (value as Record<string, unknown>).used;
  return typeof used === 'number' && Number.isFinite(used) && used >= 0 ? Math.ceil(used) : 0;
}
