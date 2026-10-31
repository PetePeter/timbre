import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliAgent } from '../src/agents/cli-agent.js';
import { buildCodexAgentOptions } from '../src/agents/codex-preset.js';
import { defaultConfig, type CliLlm } from '../src/config/timbre-config.js';

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Codex CLI launch lifecycle', () => {
  it('refreshes auth from the user home before an automatic PTY restart', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'timbre-codex-restart-'));
    const userHome = mkdtempSync(path.join(os.tmpdir(), 'timbre-codex-auth-'));
    dirs.push(dataDir, userHome);
    vi.stubEnv('CODEX_HOME', userHome);
    const sourceAuth = path.join(userHome, 'auth.json');
    writeFileSync(sourceAuth, 'auth-v1', { mode: 0o600 });
    const phone = structuredClone(defaultConfig().phones[0]);
    phone.id = 'phone';
    const llm: CliLlm = { id: 'codex', name: 'Codex', kind: 'cli', command: 'codex', args: [], cwd: '', preset: 'codex' };
    const options = buildCodexAgentOptions({ llm, phone, dataDir, mcpUrl: 'http://127.0.0.1/mcp/phone', token: 'phone-token' });
    const runCount = path.join(dataDir, 'runs.txt');
    const authSnapshots = path.join(dataDir, 'auth-snapshots.txt');
    const isolatedAuth = path.join(options.env.CODEX_HOME, 'auth.json');
    const code = [
      'const fs = require("node:fs");',
      'const count = fs.existsSync(process.env.RUN_COUNT) ? Number(fs.readFileSync(process.env.RUN_COUNT, "utf8")) + 1 : 1;',
      'fs.writeFileSync(process.env.RUN_COUNT, String(count));',
      'fs.appendFileSync(process.env.AUTH_SNAPSHOTS, fs.readFileSync(require("node:path").join(process.env.CODEX_HOME, "auth.json"), "utf8") + "\\n");',
      'if (count === 1) process.exit(7);',
      'console.log("READY:" + count);',
      'setInterval(() => {}, 1000);',
    ].join(' ');
    options.command = process.execPath;
    options.args = ['-e', code];
    options.env = { ...options.env, RUN_COUNT: runCount, AUTH_SNAPSHOTS: authSnapshots };
    const logs: string[] = [];
    let output = '';
    const agent = new CliAgent({ ...options, baseDelayMs: 500, maxDelayMs: 500, maxRestarts: 2, log: (message) => logs.push(message) });
    const unsubscribe = agent.onOutput((data) => { output += data; });

    try {
      await waitUntil(() => logs.some((message) => message.includes('restarting in 500ms')));
      writeFileSync(sourceAuth, 'auth-v2', { mode: 0o600 });
      const newer = new Date(Date.now() + 2000);
      utimesSync(sourceAuth, newer, newer);
      await waitUntil(() => output.includes('READY:2'));

      expect(readFileSync(runCount, 'utf8')).toBe('2');
      expect(readFileSync(authSnapshots, 'utf8').trim().split(/\r?\n/)).toEqual(['auth-v1', 'auth-v2']);
      expect(readFileSync(isolatedAuth, 'utf8')).toBe('auth-v2');
      expect(readFileSync(sourceAuth, 'utf8')).toBe('auth-v2');
    } finally {
      unsubscribe();
      agent.stop();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 10000);
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('timed out waiting for Codex PTY restart');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
