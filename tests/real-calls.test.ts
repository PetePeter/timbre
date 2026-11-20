import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCalls, heldOut, readRealCalls, replayScenario, type RealCall } from '../eval/real-calls.js';
import type { ChatClient, ChatMessage, CompletionResult } from '../src/session/api/api-agent-loop.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'real-calls-')); dirs.push(d); return d; };

type Line = ['local' | 'remote', string];
function record(callsDir: string, id: string, over: Record<string, unknown>, lines: Line[]) {
  const dir = path.join(callsDir, 'phone-1', 'recordings');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    date: '2026-11-13T09:02:23.937Z', contact: 'Plumber', role: 'trusted', direction: 'inbound', durationS: 40, handledBy: [],
    utterances: lines.map(([speaker, text], i) => ({ speaker, text, startMs: i * 1000, endMs: i * 1000 + 900 })),
    ...over,
  }));
}

const call = (over: Partial<RealCall>): RealCall => ({
  id: 'c', phone: 'p', direction: 'inbound', role: 'trusted', contact: 'Plumber', remote: ['Hi, is Oscar there?'], ...over,
});

/** A polite teacher stand-in: says a line each turn, hangs up once the caller says goodbye (unless told not to). */
class ScriptedTeacher implements ChatClient {
  constructor(private readonly hangsUp: boolean) {}
  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    const last = messages.at(-1)!;
    if (last.role === 'tool') return { message: { content: '' } };
    const text = JSON.stringify(last.content);
    const id = `t${Math.random()}`;
    if (this.hangsUp && /bye/i.test(text)) {
      return { message: { content: null, tool_calls: [{ id, type: 'function', function: { name: 'phone_hangup', arguments: '{}' } }] } };
    }
    return { message: { content: null, tool_calls: [{ id, type: 'function', function: { name: 'chat_send', arguments: JSON.stringify({ text: 'Sure, I will pass that on.' }) } }] } };
  }
}

describe('real call recordings', () => {
  it('reads the far end turns in order, merging back-to-back remote lines and dropping our own', () => {
    const calls = tmp();
    record(calls, 'a', { task: 'Ask for hours.', direction: 'outbound' }, [
      ['remote', 'Hello,'], ['remote', 'Smith Plumbing.'], ['local', 'Hi, I am calling for Oscar.'], ['remote', 'Sure, go on.'],
    ]);

    expect(readRealCalls(calls)).toEqual([{
      id: 'a', phone: 'phone-1', direction: 'outbound', role: 'trusted', contact: 'Plumber', task: 'Ask for hours.',
      remote: ['Hello, Smith Plumbing.', 'Sure, go on.'],
    }]);
  });

  it('only replays calls it can reproduce: no owner calls, no outbound without a task, no silent far end', () => {
    expect(replayScenario(call({}))).not.toBeNull();
    expect(replayScenario(call({ direction: 'outbound', task: 'Ask for hours.' }))).not.toBeNull();
    expect(replayScenario(call({ role: 'owner' }))).toBeNull();
    expect(replayScenario(call({ direction: 'outbound' }))).toBeNull();
    expect(replayScenario(call({ remote: [] }))).toBeNull();
  });

  it('holds out a stable fifth of calls', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `call-${i}`);
    const held = ids.filter(heldOut);
    expect(held.length / ids.length).toBeGreaterThan(0.15);
    expect(held.length / ids.length).toBeLessThan(0.25);
    expect(ids.filter(heldOut)).toEqual(held);
  });

  it('keeps passing teacher replays as training rows and replays each call only once', async () => {
    const calls = tmp();
    const out = tmp();
    const id = Array.from({ length: 50 }, (_, i) => `train-${i}`).find((x) => !heldOut(x))!;
    record(calls, id, {}, [['remote', 'Hi, it is Mark the plumber. Can you tell Oscar the part arrived?']]);

    const first = await collectCalls({ callsDir: calls, outDir: out, model: new ScriptedTeacher(true), modelName: 'teacher', hangupWaitMs: 15_000 });
    const rows = readFileSync(path.join(out, 'sft.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(first).toEqual({ replayed: 1, kept: 1 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ model: 'teacher', call: id });
    expect(JSON.stringify(rows)).toContain('the part arrived');

    const again = await collectCalls({ callsDir: calls, outDir: out, model: new ScriptedTeacher(true), modelName: 'teacher', hangupWaitMs: 15_000 });
    expect(again).toEqual({ replayed: 0, kept: 0 });
  }, 90_000);

  it('drops a replay where the agent never hangs up after the goodbye', async () => {
    const calls = tmp();
    const out = tmp();
    const id = Array.from({ length: 50 }, (_, i) => `train-${i}`).find((x) => !heldOut(x))!;
    record(calls, id, {}, [['remote', 'Tell Oscar the part arrived.']]);

    const result = await collectCalls({ callsDir: calls, outDir: out, model: new ScriptedTeacher(false), modelName: 'teacher', hangupWaitMs: 12_000 });

    expect(result).toEqual({ replayed: 1, kept: 0 });
    expect(existsSync(path.join(out, 'sft.jsonl')) ? readFileSync(path.join(out, 'sft.jsonl'), 'utf8').trim() : '').toBe('');
  }, 90_000);
});
