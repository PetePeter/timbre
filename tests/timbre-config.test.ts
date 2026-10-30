import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, addPhone, defaultConfig, normalizeConfig, removePhone, validateLlm, type ApiLlm } from '../src/config/timbre-config.js';

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), 'timbre-')), 'timbre.yaml');

describe('timbre config', () => {
  it('starts with exactly one phone wired to the first LLM', () => {
    const cfg = defaultConfig();
    expect(cfg.phones).toHaveLength(1);
    expect(cfg.phones[0].llmId).toBe(cfg.llms[0].id);
    expect(cfg.llms[0]).toMatchObject({ mode: 'handover', dailyTokenLimit: 0 });
    expect(cfg.phones[0].mcpServers).toEqual([]);
  });

  it('keeps legacy API configs in full mode and normalizes new per-phone MCP settings', () => {
    const cfg = defaultConfig();
    const api = cfg.llms[0] as import('../src/config/timbre-config.js').ApiLlm;
    const legacyLlm = { id: api.id, name: api.name, kind: api.kind, baseUrl: api.baseUrl, model: api.model, apiKey: api.apiKey };
    const mcpServers = [
      { name: 'tasks', url: 'https://mcp.example.test', headers: { Authorization: 'secret' }, allowedTools: ['list'] },
      { name: 'local', command: 'node', args: ['server.js'], cwd: 'C:/tools', env: { API_KEY: 'secret' }, allowedTools: ['run'] },
    ];
    const fixed = normalizeConfig({
      ...cfg,
      llms: [legacyLlm],
      phones: [{ ...cfg.phones[0], mcpServers }],
    } as never);
    expect(fixed.llms[0]).toMatchObject({ mode: 'full', dailyTokenLimit: 0 });
    expect(fixed.phones[0].mcpServers).toMatchObject(mcpServers);
    const serverIds = fixed.phones[0].mcpServers.map((server) => server.id);
    expect(serverIds.every(Boolean)).toBe(true);
    expect(new Set(serverIds).size).toBe(mcpServers.length);
  });

  it('drops malformed MCP servers and resets invalid API token caps', () => {
    const cfg = defaultConfig();
    const fixed = normalizeConfig({
      ...cfg,
      llms: [{ ...cfg.llms[0], mode: 'unsafe', dailyTokenLimit: -10 }],
      phones: [{ ...cfg.phones[0], mcpServers: [
        { name: 'bad', url: 'file:///etc/passwd', allowedTools: ['read'] },
        { name: 'missing-transport', allowedTools: ['read'] },
      ] }],
    } as never);
    expect(fixed.llms[0]).toMatchObject({ mode: 'full', dailyTokenLimit: 0 });
    expect(fixed.phones[0].mcpServers).toEqual([]);
  });

  it('keeps only curated Claude Code extra tools after config normalization', () => {
    const cfg = defaultConfig();
    const fixed = normalizeConfig({
      ...cfg,
      llms: [{
        id: 'claude', name: 'Claude Code', kind: 'cli', command: 'claude', args: [], cwd: '.',
        preset: 'claude-code', extraAllowedTools: ['WebFetch', 'Bash', 'Bash', 'RunAnything', ' Edit ', 42],
      }],
    } as never);

    expect(fixed.llms[0]).toMatchObject({ preset: 'claude-code', extraAllowedTools: ['Bash', 'WebFetch'] });
  });

  it('drops unknown Claude preset names instead of preserving them as config extensions', () => {
    const cfg = defaultConfig();
    const fixed = normalizeConfig({
      ...cfg,
      llms: [{ id: 'cli', name: 'CLI', kind: 'cli', command: 'claude', args: [], cwd: '.', preset: 'unrestricted' }],
    } as never);

    expect(fixed.llms[0]).not.toHaveProperty('preset');
  });

  it('gives each added phone its own telefony port', () => {
    let cfg = defaultConfig();
    cfg = addPhone(cfg, 'Work');
    cfg = addPhone(cfg, 'Spare');
    const ports = cfg.phones.map((p) => p.line.port);
    expect(new Set(ports).size).toBe(3);
  });

  it('removes the last phone and keeps the empty list after reload', () => {
    const cfg = defaultConfig();
    const file = tmp();
    const empty = removePhone(cfg, cfg.phones[0].id);
    expect(empty.phones).toEqual([]);

    const store = new ConfigStore(file);
    store.save(empty);
    expect(normalizeConfig(store.get()).phones).toEqual([]);
    expect(new ConfigStore(file).get().phones).toEqual([]);
  });

  it('repoints phones whose LLM was deleted', () => {
    const cfg = defaultConfig();
    const fixed = normalizeConfig({ ...cfg, phones: [{ ...cfg.phones[0], llmId: 'gone' }] });
    expect(fixed.phones[0].llmId).toBe(cfg.llms[0].id);
  });

  it('fills missing phone-line fields from defaults (older files keep loading)', () => {
    const cfg = defaultConfig();
    const fixed = normalizeConfig({ ...cfg, phones: [{ ...cfg.phones[0], line: { port: 9000 } as never }] });
    expect(fixed.phones[0].line.port).toBe(9000);
    expect(fixed.phones[0].line.persona.name).toBeTruthy();
    expect(fixed.phones[0].line.inboundHandling.default.action).toBe('standard');
  });

  it('defaults new persona and SAPI fields and keeps only unique absolute custom model paths', () => {
    const cfg = defaultConfig();
    const modelPath = path.resolve('voices', 'custom.onnx');
    const fixed = normalizeConfig({
      ...cfg,
      customPiperModels: [modelPath, modelPath, 'relative.onnx', null],
      phones: [{
        ...cfg.phones[0],
        line: {
          ...cfg.phones[0].line,
          persona: { name: 'Ari' },
          voice: { tts: 'sapi', piperModel: '', sttModel: '' },
        },
      } as never],
    } as never);

    expect(fixed.customPiperModels).toEqual([modelPath]);
    expect(fixed.phones[0].line.persona).toMatchObject({ name: 'Ari', tone: '', instructions: '' });
    expect(fixed.phones[0].line.voice.sapiVoice).toBe('');
  });

  it('migrates the legacy shared retention days and defaults the recording notice', () => {
    const cfg = defaultConfig();
    const line = structuredClone(cfg.phones[0].line) as unknown as Record<string, unknown>;
    delete line.recordings;
    delete line.recordingNotice;
    line.transcripts = { ...(line.transcripts as object), retentionDays: 21 };
    const fixed = normalizeConfig({ ...cfg, phones: [{ ...cfg.phones[0], line } as never] });

    expect(fixed.phones[0].line.recordings.retentionDays).toBe(21);
    expect(fixed.phones[0].line.recordingNotice).toEqual({ enabled: true, text: 'This call may be recorded.' });
  });

  it('falls back to safe retention defaults for non-finite configured days', () => {
    const cfg = defaultConfig();
    const phone = {
      ...cfg.phones[0],
      line: {
        ...cfg.phones[0].line,
        recordings: { retentionDays: Number.NaN },
        transcripts: { ...cfg.phones[0].line.transcripts, retentionDays: Number.POSITIVE_INFINITY },
      },
    };
    const fixed = normalizeConfig({ ...cfg, phones: [phone] });

    expect(fixed.phones[0].line.recordings.retentionDays).toBe(90);
    expect(fixed.phones[0].line.transcripts.retentionDays).toBe(90);
  });

  it('persists contact handling rules with the selected phone', () => {
    const file = tmp();
    const store = new ConfigStore(file);
    const cfg = store.get();
    cfg.phones[0].line.inboundHandling.rules = [{
      kind: 'group', value: 'Family', action: 'always-through', greeting: 'Hi {caller}', instructions: 'Connect to the owner.',
      smsAutoReply: { mode: 'none', text: '' },
    }];
    store.save(cfg);

    expect(new ConfigStore(file).get().phones[0].line.inboundHandling.rules).toEqual(cfg.phones[0].line.inboundHandling.rules);
  });

  it('persists and reloads', () => {
    const file = tmp();
    const store = new ConfigStore(file);
    store.save(addPhone(store.get(), 'Work'));
    expect(readFileSync(file, 'utf8')).toContain('Work');
    expect(new ConfigStore(file).get().phones.map((p) => p.name)).toContain('Work');
  });

  it('defaults newly added API LLMs to handover and preserves existing full mode', () => {
    const store = new ConfigStore(tmp());
    const first = store.get();
    const existing = { ...(first.llms[0] as ApiLlm), mode: 'full' as const };
    store.save({ ...first, llms: [existing] });
    const added = {
      id: 'new-api', name: 'New API', kind: 'api' as const,
      baseUrl: 'http://127.0.0.1/v1', model: 'm', apiKey: '',
    };
    const saved = store.save({ ...store.get(), llms: [existing, added] as never });
    expect(saved.llms[0]).toMatchObject({ id: existing.id, mode: 'full' });
    expect(saved.llms[1]).toMatchObject({ id: added.id, mode: 'handover', dailyTokenLimit: 0 });
  });

  it('creates a LAN token the first time LAN access is enabled', () => {
    const store = new ConfigStore(tmp());
    store.save({ ...store.get(), web: { ...store.get().web, lan: true, token: '' } });
    expect(store.get().web.token.length).toBeGreaterThanOrEqual(32);
  });
});

describe('validateLlm', () => {
  it('requires base URL and model for API LLMs', () => {
    expect(validateLlm({ id: 'a', name: 'A', kind: 'api', baseUrl: '', model: '', apiKey: '', mode: 'full', dailyTokenLimit: 0 })).toEqual(['baseUrl', 'model']);
    expect(validateLlm({ id: 'a', name: 'A', kind: 'api', baseUrl: 'http://x/v1', model: 'm', apiKey: '', mode: 'full', dailyTokenLimit: 0 })).toEqual([]);
  });

  it('requires a command for CLI LLMs', () => {
    expect(validateLlm({ id: 'c', name: 'C', kind: 'cli', command: ' ', args: [], cwd: '' })).toEqual(['command']);
  });
});
