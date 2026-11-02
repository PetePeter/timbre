/**
 * `npm run eval`: every selected model through every scenario.
 * Writes report.md, results.json and sft.jsonl (completions from fully passing
 * runs, ready for fine-tuning) under <dataDir>/eval/<timestamp>/.
 * Filter with TIMBRE_EVAL_MODELS / TIMBRE_EVAL_SCENARIOS (comma-separated).
 */
import { afterAll, describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../src/config/timbre-config.js';
import { runScenario, type RunResult } from './harness.js';
import { chatClient, selectedModels } from './models.js';
import { SCENARIOS } from './scenarios.js';

interface Row { model: string; scenario: string; passed: string[]; failed: string[]; ms: number; result: RunResult }

const rows: Row[] = [];
const wanted = process.env.TIMBRE_EVAL_SCENARIOS?.split(',').map((s) => s.trim()).filter(Boolean);
const scenarios = wanted ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS;

for (const spec of selectedModels()) {
  describe(spec.name, () => {
    for (const scenario of scenarios) {
      it(scenario.title, async () => {
        const start = Date.now();
        const result = await runScenario(scenario, chatClient(spec));
        const passed: string[] = [];
        const failed: string[] = [];
        for (const check of scenario.checks) (check.pass(result) ? passed : failed).push(check.name);
        rows.push({ model: spec.name, scenario: scenario.id, passed, failed, ms: Date.now() - start, result });
        // Scores are the output; a weak model is a result, not a broken eval.
      }, 15 * 60_000);
    }
  });
}

afterAll(() => {
  if (!rows.length) return;
  const dir = path.join(dataDir(), 'eval', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'results.json'), JSON.stringify(rows, null, 2));
  writeFileSync(path.join(dir, 'sft.jsonl'), rows
    .filter((row) => row.failed.length === 0)
    .flatMap((row) => row.result.samples.map((s) => JSON.stringify({
      model: row.model, scenario: row.scenario, tools: s.tools,
      messages: [...s.messages, { role: 'assistant', content: s.response.content ?? null, tool_calls: s.response.tool_calls }],
    })))
    .join('\n'));
  writeFileSync(path.join(dir, 'report.md'), report(rows));
  console.log(`\n${report(rows)}\nEval output: ${dir}`);
});

function report(all: Row[]): string {
  const models = [...new Set(all.map((r) => r.model))];
  const lines = ['# Phone agent eval', '', '| Model | Checks passed | Scenarios fully passed | Mean model latency |', '|---|---|---|---|'];
  for (const model of models) {
    const mine = all.filter((r) => r.model === model);
    const pass = mine.reduce((n, r) => n + r.passed.length, 0);
    const total = mine.reduce((n, r) => n + r.passed.length + r.failed.length, 0);
    const samples = mine.flatMap((r) => r.result.samples);
    const latency = samples.length ? Math.round(samples.reduce((n, s) => n + s.ms, 0) / samples.length) : 0;
    lines.push(`| ${model} | ${pass}/${total} | ${mine.filter((r) => !r.failed.length).length}/${mine.length} | ${latency} ms |`);
  }
  for (const row of all) {
    lines.push('', `## ${row.model} — ${row.scenario} (${Math.round(row.ms / 1000)} s)`);
    if (row.failed.length) lines.push(`Failed: ${row.failed.join('; ')}`);
    if (row.result.errors.length) lines.push(`Errors: ${row.result.errors.slice(0, 3).join(' | ')}`);
    lines.push('```', ...row.result.transcript.map((e) => `${e.speaker.padEnd(5)} ${e.text}`), '```');
  }
  return lines.join('\n');
}
