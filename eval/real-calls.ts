/**
 * Real calls → training data. Each archived call record (calls/<phone>/recordings/<id>.json,
 * see X:\LLM\timbre-training\archive-calls.sh) becomes a replay: the far end says what the
 * real caller said, a teacher model plays Timbre, and only passing runs are kept.
 * Held-out calls go to heldout.jsonl and are never trained on.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatClient } from '../src/session/api/api-agent-loop.js';
import { runScenario, sftRows, type RunResult, type Scenario } from './harness.js';

export interface RealCall {
  id: string;
  phone: string;
  direction: 'inbound' | 'outbound';
  role: string;
  contact: string;
  task?: string;
  /** The far end's turns, in order (back-to-back lines merged). */
  remote: string[];
}

const CALLER = '+61491570150';
const CALLEE = '+61491570151';
const GOODBYE = 'Okay, thanks. Bye.';

export function readRealCalls(callsDir: string): RealCall[] {
  if (!existsSync(callsDir)) return [];
  const calls: RealCall[] = [];
  for (const phone of readdirSync(callsDir)) {
    const dir = path.join(callsDir, phone, 'recordings');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const rec = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as {
          direction: RealCall['direction']; role: string; contact: string; task?: string;
          utterances?: Array<{ speaker: string; text: string }>;
        };
        const remote: string[] = [];
        let previous = '';
        for (const u of rec.utterances ?? []) {
          const text = u.text.trim();
          if (u.speaker === 'remote' && text) {
            if (previous === 'remote') remote[remote.length - 1] += ` ${text}`;
            else remote.push(text);
          }
          previous = u.speaker;
        }
        calls.push({
          id: file.slice(0, -5), phone, direction: rec.direction, role: rec.role, contact: rec.contact,
          ...(rec.task ? { task: rec.task } : {}), remote,
        });
      } catch { /* a half-written or foreign file: skip */ }
    }
  }
  return calls;
}

/** About a fifth of calls, chosen by id so a call never moves between sets. */
export function heldOut(id: string): boolean {
  return createHash('sha256').update(id).digest()[0] < 256 * 0.2;
}

/** The replay of a real call, or null when it can't be reproduced (owner calls, outbound without a task, silent far end). */
export function replayScenario(call: RealCall, hangupWaitMs = 30_000): Scenario | null {
  if (call.role === 'owner' || !call.remote.length) return null;
  if (call.direction === 'outbound' && !call.task) return null;
  const inbound = call.direction === 'inbound';
  return {
    id: `real:${call.id}`,
    title: `Replay of a real ${call.direction} call`,
    direction: call.direction,
    ...(inbound
      ? { caller: CALLER }
      : { to: CALLEE, task: call.task }),
    async play(far) {
      if (inbound) await far.reply(60_000);  // greeting
      for (const line of call.remote) {
        far.speak(line);
        await far.reply(60_000);
      }
      far.speak(GOODBYE);
      // phone_hangup asks "anything else?" and hangs up after a 10 s grace when the caller stays quiet.
      await far.sawMethod('call.hangup', hangupWaitMs);
    },
    checks: [
      { name: 'speaks', pass: (r: RunResult) => r.said.length > 0 },
      { name: 'hangs up after the goodbye', pass: (r: RunResult) => r.transcript.some((e) => e.speaker === 'event' && e.text === 'agent hung up') },
    ],
  };
}

export interface CollectOptions { callsDir: string; outDir: string; model: ChatClient; modelName: string; hangupWaitMs?: number }

/**
 * Replays every call not processed yet. Passing runs append to sft.jsonl (or heldout.jsonl);
 * processed.json records each call so it costs teacher calls once.
 */
export async function collectCalls(opts: CollectOptions): Promise<{ replayed: number; kept: number }> {
  mkdirSync(opts.outDir, { recursive: true });
  // A file, not the console: vitest hides the output of passing runs.
  const log = (line: string) => appendFileSync(path.join(opts.outDir, 'collect.log'), `${new Date().toISOString()} ${line}\n`);
  const processedFile = path.join(opts.outDir, 'processed.json');
  const processed = new Set<string>(existsSync(processedFile) ? JSON.parse(readFileSync(processedFile, 'utf8')) as string[] : []);
  let replayed = 0;
  let kept = 0;
  for (const call of readRealCalls(opts.callsDir)) {
    if (processed.has(call.id)) continue;
    const scenario = replayScenario(call, opts.hangupWaitMs);
    if (scenario) {
      replayed++;
      const result = await runScenario(scenario, opts.model);
      if (result.errors.length) {  // e.g. the teacher API was down: retry next run
        log(`${call.id}: errors, will retry (${result.errors.slice(0, 2).join(' | ')})`);
        continue;
      }
      const failed = scenario.checks.filter((c) => !c.pass(result)).map((c) => c.name);
      if (failed.length) log(`${call.id}: dropped (${failed.join('; ')})`);
      else {
        kept++;
        const rows = sftRows(result.samples, { model: opts.modelName, call: call.id });
        appendFileSync(path.join(opts.outDir, heldOut(call.id) ? 'heldout.jsonl' : 'sft.jsonl'), rows.map((r) => `${r}\n`).join(''));
      }
    }
    processed.add(call.id);  // skipped calls too: an archived record never changes
    writeFileSync(processedFile, JSON.stringify([...processed], null, 2));
  }
  log(`replayed ${replayed}, kept ${kept}`);
  return { replayed, kept };
}
