import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildClaudeCodeAgentOptions } from '../src/agents/claude-code-preset.js';
import { PHONE_TOOLS } from '../src/agents/phone-tools.js';
import { defaultConfig, type CliLlm } from '../src/config/timbre-config.js';

describe('Claude Code preset', () => {
  it('writes isolated settings and uses only restricted per-phone launch arguments', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'timbre-claude-preset-'));
    try {
      const phoneA = structuredClone(defaultConfig().phones[0]);
      phoneA.id = 'phone-a';
      phoneA.line.persona = { ...phoneA.line.persona, name: 'Ari', tone: 'Warm', instructions: 'Keep replies brief.' };
      const phoneB = structuredClone(phoneA);
      phoneB.id = 'phone-b';
      phoneB.line.persona.name = 'Bea';
      const llm = {
        id: 'claude', name: 'Claude Code', kind: 'cli', command: 'claude',
        args: ['--settings', 'untrusted.json', '--append-system-prompt', 'untrusted prompt'],
        cwd: 'C:/untrusted', preset: 'claude-code', extraAllowedTools: ['WebFetch', 'Bash'],
      } as CliLlm;
      const log = vi.fn();

      const optionsA = buildClaudeCodeAgentOptions({ llm, phone: phoneA, dataDir, mcpUrl: 'http://localhost/mcp/phone-a', token: 'token-secret', log });
      const optionsB = buildClaudeCodeAgentOptions({ llm, phone: phoneB, dataDir, mcpUrl: 'http://localhost/mcp/phone-b', token: 'phone-b-token' });
      const settingsA = path.join(dataDir, 'phones', phoneA.id, 'claude-settings.json');
      const settingsB = path.join(dataDir, 'phones', phoneB.id, 'claude-settings.json');
      const settings = JSON.parse(readFileSync(settingsA, 'utf8')) as { permissions: { allow: string[]; deny: string[] } };
      const mcpA = path.join(dataDir, 'phones', phoneA.id, 'mcp.json');

      expect(optionsA.command).toBe('claude');
      expect(optionsA.log).toBe(log);
      expect(optionsA.cwd).toBe(path.join(dataDir, 'phones', phoneA.id));
      expect(optionsB.cwd).toBe(path.join(dataDir, 'phones', phoneB.id));
      expect(settingsA).not.toBe(settingsB);
      expect(optionsA.args).toContain('--restricted');
      expect(optionsA.args).toContain('--strict-mcp-config');
      expect(optionsA.args).toContain('--permission-mode');
      expect(optionsA.args[optionsA.args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
      expect(optionsA.args[optionsA.args.indexOf('--mcp-config') + 1]).toBe(mcpA);
      expect(optionsA.args[optionsA.args.indexOf('--settings') + 1]).toBe(settingsA);
      expect(optionsA.args[optionsA.args.indexOf('--tools') + 1]).toBe('Bash,WebFetch,WebSearch');
      expect(optionsA.args).not.toContain('untrusted.json');
      expect(optionsA.args).not.toContain('untrusted prompt');

      const promptIndex = optionsA.args.indexOf('--append-system-prompt');
      expect(promptIndex).toBe(optionsA.args.length - 2);
      expect(optionsA.args[promptIndex + 1]).toContain('You are Ari');
      expect(optionsA.args[promptIndex + 1]).toContain('Keep replies brief.');
      expect(optionsA.args[promptIndex + 1]).toContain('[PHONE SMS]');
      expect(optionsA.args[promptIndex + 1]).not.toContain('token-secret');

      expect(settings.permissions.allow).toEqual([
        ...PHONE_TOOLS.map((tool) => `mcp__timbre__${tool.name}`), 'Bash', 'WebFetch', 'WebSearch',
      ]);
      expect(settings.permissions.deny).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit']);
      expect(JSON.parse(readFileSync(settingsB, 'utf8')).permissions.allow).toContain('mcp__timbre__verify_caller');
      expect(existsSync(settingsA)).toBe(true);
      expect(readdirSync(path.dirname(settingsA)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(JSON.parse(readFileSync(mcpA, 'utf8'))).toEqual({
        mcpServers: {
          timbre: { type: 'http', url: 'http://localhost/mcp/phone-a', headers: { Authorization: 'Bearer token-secret' } },
        },
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('writes HTTP and stdio client servers with matching Claude tool permissions', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'timbre-claude-client-mcp-'));
    try {
      const phone = structuredClone(defaultConfig().phones[0]);
      phone.id = 'phone';
      phone.mcpServers = [
        { name: 'calendar', url: 'https://calendar.example/mcp', headers: { Authorization: 'Bearer calendar-secret' }, allowedTools: ['list_events', 'create_event'] },
        { name: 'local', command: 'node', args: ['server.js'], cwd: 'C:/mcp-tools', env: { API_KEY: 'stdio-secret' }, allowedTools: [] },
      ];
      const llm = {
        id: 'claude', name: 'Claude Code', kind: 'cli', command: 'claude', args: [], cwd: '',
        preset: 'claude-code', extraAllowedTools: [],
      } as CliLlm;
      buildClaudeCodeAgentOptions({
        llm, phone, dataDir, mcpUrl: 'http://localhost/mcp/phone', token: 'phone-secret',
      });

      const phoneDir = path.join(dataDir, 'phones', phone.id);
      const mcpConfig = JSON.parse(readFileSync(path.join(phoneDir, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
      const settings = JSON.parse(readFileSync(path.join(phoneDir, 'claude-settings.json'), 'utf8')) as { permissions: { allow: string[]; deny: string[] } };
      expect(mcpConfig.mcpServers).toEqual({
        timbre: { type: 'http', url: 'http://localhost/mcp/phone', headers: { Authorization: 'Bearer phone-secret' } },
        calendar: { type: 'http', url: 'https://calendar.example/mcp', headers: { Authorization: 'Bearer calendar-secret' } },
        local: { type: 'stdio', command: 'node', args: ['server.js'], env: { API_KEY: 'stdio-secret' } },
      });
      expect(settings.permissions.allow).toEqual([
        ...PHONE_TOOLS.map((tool) => `mcp__timbre__${tool.name}`),
        'mcp__calendar__list_events', 'mcp__calendar__create_event', 'mcp__local__*',
      ]);
      expect(settings.permissions.deny).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']);
      expect(readdirSync(phoneDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps the built-in timbre entry when it rejects reserved or invalid client server entries', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'timbre-claude-invalid-mcp-'));
    try {
      const phone = structuredClone(defaultConfig().phones[0]);
      phone.id = 'phone';
      phone.mcpServers = [
        { name: 'timbre', url: 'https://collision.example/mcp', allowedTools: [] },
        { name: 'dot.name', url: 'https://invalid.example/mcp', allowedTools: ['run'] },
        { name: 'broken', url: 'ftp://invalid.example/mcp', allowedTools: [] },
      ];
      const llm = {
        id: 'claude', name: 'Claude Code', kind: 'cli', command: 'claude', args: [], cwd: '',
        preset: 'claude-code', extraAllowedTools: [],
      } as CliLlm;

      buildClaudeCodeAgentOptions({ llm, phone, dataDir, mcpUrl: 'http://localhost/mcp/phone', token: 'phone-secret' });

      const mcpConfig = JSON.parse(readFileSync(path.join(dataDir, 'phones', phone.id, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
      const settings = JSON.parse(readFileSync(path.join(dataDir, 'phones', phone.id, 'claude-settings.json'), 'utf8')) as { permissions: { allow: string[] } };
      expect(Object.keys(mcpConfig.mcpServers)).toEqual(['timbre']);
      expect(settings.permissions.allow).toEqual(PHONE_TOOLS.map((tool) => `mcp__timbre__${tool.name}`));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('replaces an existing settings file and writes its temporary beside the target', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'timbre-claude-atomic-'));
    try {
      const phone = structuredClone(defaultConfig().phones[0]);
      phone.id = 'phone';
      const phoneDir = path.join(dataDir, 'phones', phone.id);
      mkdirSync(phoneDir, { recursive: true });
      const settings = path.join(phoneDir, 'claude-settings.json');
      writeFileSync(settings, 'old settings');
      const llm = {
        id: 'claude', name: 'Claude Code', kind: 'cli', command: 'claude', args: [], cwd: '',
        preset: 'claude-code', extraAllowedTools: [],
      } as CliLlm;

      buildClaudeCodeAgentOptions({ llm, phone, dataDir, mcpUrl: 'http://localhost/mcp/phone', token: 'phone-secret' });

      expect(JSON.parse(readFileSync(settings, 'utf8'))).toHaveProperty('permissions');
      expect(readdirSync(phoneDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
