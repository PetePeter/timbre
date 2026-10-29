import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatClient } from '../src/session/api/api-agent-loop.js';
import { DailyTokenBudget, TokenBudgetExceededError } from '../src/agents/daily-token-budget.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function file() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-token-budget-'));
  dirs.push(dir);
  return path.join(dir, 'phones', 'phone-1', 'api-usage.json');
}

describe('DailyTokenBudget', () => {
  it('persists completion usage, blocks after the limit, and resets on the next local day', async () => {
    const path = file();
    let now = new Date(2026, 0, 2, 12);
    const budget = new DailyTokenBudget(path, 5, () => now);
    let calls = 0;
    const client: ChatClient = { async complete() { calls++; return { message: { content: '' }, usage: { total_tokens: 3 } }; } };
    const limited = budget.wrap(client);

    await limited.complete([], []);
    await limited.complete([], []);
    expect(budget.used).toBe(6);
    expect(budget.isExceeded).toBe(true);
    await expect(limited.complete([], [])).rejects.toBeInstanceOf(TokenBudgetExceededError);
    expect(calls).toBe(2);

    const restored = new DailyTokenBudget(path, 5, () => now);
    expect(restored.used).toBe(6);
    now = new Date(2026, 0, 3, 0);
    expect(restored.used).toBe(0);
    expect(restored.isExceeded).toBe(false);
  });

  it('fails closed when a capped provider omits usage', async () => {
    const budget = new DailyTokenBudget(file(), 100, () => new Date(2026, 0, 2));
    let calls = 0;
    const limited = budget.wrap({ async complete() { calls++; return { message: { content: '' } }; } });
    await limited.complete([], []);
    expect(budget.isExceeded).toBe(true);
    await expect(limited.complete([], [])).rejects.toBeInstanceOf(TokenBudgetExceededError);
    expect(calls).toBe(1);
  });

  it('fails closed and preserves known usage when the saved day is malformed', () => {
    const usagePath = file();
    mkdirSync(path.dirname(usagePath), { recursive: true });
    writeFileSync(usagePath, JSON.stringify({ day: 'not-a-day', used: 42 }));
    const logs: string[] = [];
    const budget = new DailyTokenBudget(usagePath, 100, () => new Date(2026, 0, 2), (message) => logs.push(message));

    expect(budget.used).toBe(42);
    expect(budget.isExceeded).toBe(true);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(readFileSync(usagePath, 'utf8'))).toMatchObject({ day: '2026-01-02', used: 42, unknownUsage: true });
  });

  it('charges a completion to the local day on which it finishes', async () => {
    const path = file();
    let now = new Date(2026, 0, 2, 23, 59);
    const budget = new DailyTokenBudget(path, 5, () => now);
    const client: ChatClient = {
      async complete() {
        now = new Date(2026, 0, 3, 0, 1);
        return { message: { content: '' }, usage: { total_tokens: 2 } };
      },
    };
    await budget.wrap(client).complete([], []);
    expect(new DailyTokenBudget(path, 5, () => now).used).toBe(2);
  });

  it('records usage without limiting uncapped clients', async () => {
    const budget = new DailyTokenBudget(file(), 0);
    let calls = 0;
    const limited = budget.wrap({ async complete() { calls++; return { message: { content: '' }, usage: { total_tokens: 3 } }; } });
    await limited.complete([], []);
    await limited.complete([], []);
    expect(calls).toBe(2);
    expect(budget.used).toBe(6);
    expect(budget.isExceeded).toBe(false);
  });

  it('fails closed when the per-phone usage file cannot be persisted', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-token-budget-'));
    dirs.push(dir);
    const parent = path.join(dir, 'phones');
    writeFileSync(parent, 'occupied');
    const budget = new DailyTokenBudget(path.join(parent, 'phone-1', 'api-usage.json'), 100);
    expect(budget.isExceeded).toBe(true);
  });
});
