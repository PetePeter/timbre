import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCodexAgentOptions } from '../src/agents/codex-preset.js';
import { defaultConfig, type CliLlm } from '../src/config/timbre-config.js';

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Codex preset', () => {
  it('writes one isolated phone MCP config and refreshes only newer user auth', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'timbre-codex-preset-'));
    const userHome = mkdtempSync(path.join(os.tmpdir(), 'timbre-codex-user-'));
    dirs.push(dataDir, userHome);
    vi.stubEnv('CODEX_HOME', userHome);
    const sourceAuth = path.join(userHome, 'auth.json');
    const userConfig = path.join(userHome, 'config.toml');
    writeFileSync(sourceAuth, '{"refresh":"source-v1"}\n', { mode: 0o600 });
    writeFileSync(userConfig, '[mcp_servers.personal]\nurl = "https://private.example/mcp"\n');
    const phoneA = structuredClone(defaultConfig().phones[0]);
    phoneA.id = 'phone-a';
    phoneA.line.persona = { ...phoneA.line.persona, name: 'Ari', tone: 'Warm', instructions: 'Keep replies brief.' };
    const phoneB = structuredClone(phoneA);
    phoneB.id = 'phone-b';
    phoneB.line.persona.name = 'Bea';
    const llm = {
      id: 'codex', name: 'Codex', kind: 'cli', command: 'codex',
      args: ['--profile', 'untrusted', '--dangerously-bypass-approvals-and-sandbox'],
      cwd: 'C:/untrusted', preset: 'codex',
    } as CliLlm;
    const tokenA = 'phone-a-secret';
    const optionsA = buildCodexAgentOptions({ llm, phone: phoneA, dataDir, mcpUrl: 'http://localhost/mcp/phone-a', token: tokenA });
    const optionsB = buildCodexAgentOptions({ llm, phone: phoneB, dataDir, mcpUrl: 'http://localhost/mcp/phone-b', token: 'phone-b-secret' });
    optionsA.beforeSpawn?.();
    optionsB.beforeSpawn?.();
    const homeA = path.join(dataDir, 'phones', phoneA.id, 'codex-home');
    const homeB = path.join(dataDir, 'phones', phoneB.id, 'codex-home');
    const configAPath = path.join(homeA, 'config.toml');
    const configBPath = path.join(homeB, 'config.toml');
    const launchScriptPath = path.join(homeA, 'launch-codex.ps1');
    const configA = readFileSync(configAPath, 'utf8');

    expect(optionsA.command).toBe(process.platform === 'win32' ? 'powershell.exe' : 'codex');
    expect(optionsA.args).toEqual(process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launchScriptPath]
      : ['--strict-config', '--sandbox', 'read-only']);
    expect(optionsA.cwd).toBe(path.join(homeA, 'workspace'));
    expect(optionsA.env).toEqual({ CODEX_HOME: homeA, TIMBRE_MCP_TOKEN: tokenA });
    expect(optionsA.args.join('\0')).not.toContain(tokenA);
    expect(configA).toContain('approval_policy = "never"');
    expect(configA).toContain('sandbox_mode = "read-only"');
    expect(configA).toContain('check_for_update_on_startup = false');
    expect(configA).toContain('shell_tool = false');
    expect(configA).toContain('multi_agent = false');
    expect(configA).toContain('trust_level = "trusted"');
    expect(configA).toContain('[mcp_servers.timbre]');
    expect(configA).toContain('url = "http://localhost/mcp/phone-a"');
    expect(configA).toContain('bearer_token_env_var = "TIMBRE_MCP_TOKEN"');
    expect(configA).toContain('default_tools_approval_mode = "approve"');
    expect(configA).toContain('You are Ari');
    expect(configA).toContain('Keep replies brief.');
    expect(configA).not.toContain(tokenA);
    expect(configA).not.toContain('personal');
    if (process.platform === 'win32') {
      expect(readFileSync(launchScriptPath, 'utf8')).toContain("& 'codex' '--strict-config' '--sandbox' 'read-only'");
    }
    expect(readFileSync(path.join(homeA, 'auth.json'), 'utf8')).toBe('{"refresh":"source-v1"}\n');
    expect(readFileSync(path.join(homeB, 'auth.json'), 'utf8')).toBe('{"refresh":"source-v1"}\n');
    expect(readFileSync(configBPath, 'utf8')).toContain('You are Bea');
    expect(readFileSync(configBPath, 'utf8')).toContain('url = "http://localhost/mcp/phone-b"');
    expect(existsSync(userConfig)).toBe(true);
    expect(readFileSync(userConfig, 'utf8')).toContain('personal');

    writeFileSync(sourceAuth, '{"refresh":"source-v2"}\n', { mode: 0o600 });
    const newer = new Date(Date.now() + 2000);
    utimesSync(sourceAuth, newer, newer);
    const refreshed = buildCodexAgentOptions({ llm, phone: phoneA, dataDir, mcpUrl: 'http://localhost/mcp/phone-a', token: tokenA });
    refreshed.beforeSpawn?.();

    expect(refreshed.env.CODEX_HOME).toBe(homeA);
    expect(readFileSync(path.join(homeA, 'auth.json'), 'utf8')).toBe('{"refresh":"source-v2"}\n');
    expect(readFileSync(sourceAuth, 'utf8')).toBe('{"refresh":"source-v2"}\n');
    expect(readdirSync(homeA).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(path.join(homeA, 'auth.json')).mode & 0o777).toBe(0o600);
  });

  it('keeps auth when the isolated copy is newer than the user copy', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'timbre-codex-newer-'));
    const userHome = mkdtempSync(path.join(os.tmpdir(), 'timbre-codex-source-'));
    dirs.push(dataDir, userHome);
    vi.stubEnv('CODEX_HOME', userHome);
    const phone = structuredClone(defaultConfig().phones[0]);
    phone.id = 'phone';
    const home = path.join(dataDir, 'phones', phone.id, 'codex-home');
    mkdirSync(home, { recursive: true });
    const sourceAuth = path.join(userHome, 'auth.json');
    const targetAuth = path.join(home, 'auth.json');
    writeFileSync(sourceAuth, 'old user token');
    writeFileSync(targetAuth, 'new isolated token');
    const newer = new Date(Date.now() + 2000);
    utimesSync(targetAuth, newer, newer);
    const llm = { id: 'codex', name: 'Codex', kind: 'cli', command: 'codex', args: [], cwd: '', preset: 'codex' } as CliLlm;

    const options = buildCodexAgentOptions({ llm, phone, dataDir, mcpUrl: 'http://localhost/mcp/phone', token: 'phone-token' });
    options.beforeSpawn?.();

    expect(readFileSync(targetAuth, 'utf8')).toBe('new isolated token');
  });
});
