import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ptyMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node-pty', () => ptyMock);

import { Hub, type HubLine } from '../src/hub.js';
import { ConfigStore, defaultConfig, type CliLlm } from '../src/config/timbre-config.js';
import type { PhoneLineStatus } from '../src/phone/phone-line-service.js';

const dirs: string[] = [];
const hubs: Hub[] = [];

function fakeLine(): HubLine & { setCallActive(active: boolean): void } {
  let callActive = false;
  const listeners = new Set<(status: PhoneLineStatus) => void>();
  const status = (): PhoneLineStatus => ({
    enabled: false,
    process: { state: 'stopped' },
    pendingRestart: false,
    line: callActive ? {
      connected: true, link: 'up', liveAudioAvailable: false,
      call: { callId: 'call-1', label: 'Caller', state: 'active', sessionName: 'Phone', participants: 1 },
      usage: { callsLastHour: 0, smsLastHour: 0 }, decisions: [],
    } : null,
    configPath: '',
  });
  const line: HubLine & { setCallActive(active: boolean): void } = {
    setCallActive(active) { callActive = active; for (const listener of listeners) listener(status()); },
    on(event, listener) { if (event === 'status') listeners.add(listener); return line; },
    off(event, listener) { if (event === 'status') listeners.delete(listener); return line; },
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    async sendSms() { return { sent: false, reason: 'unused' }; }, getStatus: status,
    async sendToSession() { return { sent: true }; }, async hangup() {}, async inbox() { return []; },
    async startCallAgent() { return {}; }, async verifyCaller() { return 'Caller verified.'; },
    isCallerVerified() { return true; }, isCallHolder() { return callActive; }, transfer() { return false; },
    enterMessageMode() { return false; }, reportCallOutcome() { return false; },
  };
  return line;
}

beforeEach(() => {
  ptyMock.spawn.mockImplementation(() => ({
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write() {}, kill() {}, resize() {},
  }));
});

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Claude Code Hub lifecycle', () => {
  it('defers persona and extra-tool changes until the active call ends', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-claude-hub-'));
    dirs.push(dir);
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    const initial = defaultConfig();
    const phone = initial.phones[0];
    const llm: CliLlm = {
      id: 'claude', name: 'Claude Code', kind: 'cli', command: 'claude', args: [], cwd: '',
      preset: 'claude-code', extraAllowedTools: [],
    };
    store.save({ ...initial, llms: [llm], phones: [{ ...phone, llmId: llm.id }] });
    const line = fakeLine();
    const hub = new Hub({
      store, dataDir: dir, version: 'test', log: () => undefined, mcpUrl: (id) => `http://localhost/mcp/${id}`,
      createLine: () => line,
    });
    hubs.push(hub);
    await hub.apply();
    const originalAgent = hub.agent(phone.id);
    const settingsPath = path.join(dir, 'phones', phone.id, 'claude-settings.json');
    const mcpConfig = JSON.parse(readFileSync(path.join(dir, 'phones', phone.id, 'mcp.json'), 'utf8'));
    const authorization = mcpConfig.mcpServers.timbre.headers.Authorization as string;
    const token = authorization.replace(/^Bearer /, '');
    expect(hub.phoneForToken(token)).toBe(phone.id);
    expect(ptyMock.spawn.mock.calls[0][1].join('\0')).not.toContain(token);

    line.setCallActive(true);
    store.save({
      ...store.get(),
      llms: store.get().llms.map((entry) => entry.kind === 'cli'
        ? { ...entry, extraAllowedTools: ['WebFetch'] }
        : entry),
      phones: store.get().phones.map((entry) => ({
        ...entry,
        line: { ...entry.line, persona: { ...entry.line.persona, tone: 'Careful and brief' } },
      })),
    });
    await hub.apply();

    expect(hub.agent(phone.id)).toBe(originalAgent);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.deny).toContain('WebFetch');

    line.setCallActive(false);
    const deadline = Date.now() + 1000;
    while (hub.agent(phone.id) === originalAgent && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));

    expect(hub.agent(phone.id)).not.toBe(originalAgent);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.allow).toContain('WebFetch');
    const lastArgs = ptyMock.spawn.mock.calls.at(-1)?.[1] as string[];
    const prompt = lastArgs[lastArgs.indexOf('--append-system-prompt') + 1];
    expect(lastArgs.join('\0')).not.toContain(token);
    expect(prompt).toContain('Tone: Careful and brief');
    expect(prompt).not.toContain(token);
  });

  it('launches Codex with only the phone MCP and a refreshed isolated auth copy', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-codex-hub-'));
    const userHome = mkdtempSync(path.join(os.tmpdir(), 'timbre-codex-user-'));
    dirs.push(dir, userHome);
    vi.stubEnv('CODEX_HOME', userHome);
    const sourceAuth = path.join(userHome, 'auth.json');
    writeFileSync(sourceAuth, '{"refresh":"user-auth"}\n', { mode: 0o600 });
    writeFileSync(path.join(userHome, 'config.toml'), '[mcp_servers.personal]\nurl = "https://private.example/mcp"\n');
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    const initial = defaultConfig();
    const phone = initial.phones[0];
    const llm: CliLlm = {
      id: 'codex', name: 'Codex', kind: 'cli', command: 'codex',
      args: ['--dangerously-bypass-approvals-and-sandbox'], cwd: 'C:/untrusted', preset: 'codex',
    };
    store.save({ ...initial, llms: [llm], phones: [{ ...phone, llmId: llm.id }] });
    const mcpUrl = `http://localhost/mcp/${phone.id}`;
    const hub = new Hub({
      store, dataDir: dir, version: 'test', log: () => undefined, mcpUrl: () => mcpUrl,
      createLine: () => fakeLine(),
    });
    hubs.push(hub);

    await hub.apply();

    const [command, args, spawnOptions] = ptyMock.spawn.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
    const codexHome = path.join(dir, 'phones', phone.id, 'codex-home');
    const config = readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const mcpConfig = JSON.parse(readFileSync(path.join(dir, 'phones', phone.id, 'mcp.json'), 'utf8'));
    const token = (mcpConfig.mcpServers.timbre.headers.Authorization as string).replace(/^Bearer /, '');

    expect(command).toBe(process.platform === 'win32' ? 'powershell.exe' : 'codex');
    expect(spawnOptions.cwd).toBe(path.join(codexHome, 'workspace'));
    expect(spawnOptions.env.CODEX_HOME).toBe(codexHome);
    expect(spawnOptions.env.TIMBRE_MCP_TOKEN).toBe(token);
    expect(args).toEqual(process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(codexHome, 'launch-codex.ps1')]
      : ['--strict-config', '--sandbox', 'read-only']);
    expect(args.join('\0')).not.toContain(token);
    expect(config.match(/^\[mcp_servers\.[^\]]+\]/gm)).toEqual(['[mcp_servers.timbre]']);
    expect(config).toContain(`url = "${mcpUrl}"`);
    expect(config).toContain('bearer_token_env_var = "TIMBRE_MCP_TOKEN"');
    expect(config).not.toContain('https://private.example/mcp');
    expect(config).not.toContain(token);
    expect(readFileSync(path.join(codexHome, 'auth.json'), 'utf8')).toBe('{"refresh":"user-auth"}\n');
    expect(readFileSync(sourceAuth, 'utf8')).toBe('{"refresh":"user-auth"}\n');
    expect(hub.phoneForToken(token)).toBe(phone.id);
  });
});
