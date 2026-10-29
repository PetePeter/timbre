import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, addPhone, defaultConfig, normalizeConfig, removePhone, validateLlm } from '../src/config/timbre-config.js';

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), 'timbre-')), 'timbre.yaml');

describe('timbre config', () => {
  it('starts with exactly one phone wired to the first LLM', () => {
    const cfg = defaultConfig();
    expect(cfg.phones).toHaveLength(1);
    expect(cfg.phones[0].llmId).toBe(cfg.llms[0].id);
  });

  it('gives each added phone its own telefony port', () => {
    let cfg = defaultConfig();
    cfg = addPhone(cfg, 'Work');
    cfg = addPhone(cfg, 'Spare');
    const ports = cfg.phones.map((p) => p.line.port);
    expect(new Set(ports).size).toBe(3);
  });

  it('never removes the last phone', () => {
    const cfg = defaultConfig();
    expect(() => removePhone(cfg, cfg.phones[0].id)).toThrow(/last phone/);
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
  });

  it('persists and reloads', () => {
    const file = tmp();
    const store = new ConfigStore(file);
    store.save(addPhone(store.get(), 'Work'));
    expect(readFileSync(file, 'utf8')).toContain('Work');
    expect(new ConfigStore(file).get().phones.map((p) => p.name)).toContain('Work');
  });

  it('creates a LAN token the first time LAN access is enabled', () => {
    const store = new ConfigStore(tmp());
    store.save({ ...store.get(), web: { ...store.get().web, lan: true, token: '' } });
    expect(store.get().web.token.length).toBeGreaterThanOrEqual(32);
  });
});

describe('validateLlm', () => {
  it('requires base URL and model for API LLMs', () => {
    expect(validateLlm({ id: 'a', name: 'A', kind: 'api', baseUrl: '', model: '', apiKey: '' })).toEqual(['baseUrl', 'model']);
    expect(validateLlm({ id: 'a', name: 'A', kind: 'api', baseUrl: 'http://x/v1', model: 'm', apiKey: '' })).toEqual([]);
  });

  it('requires a command for CLI LLMs', () => {
    expect(validateLlm({ id: 'c', name: 'C', kind: 'cli', command: ' ', args: [], cwd: '' })).toEqual(['command']);
  });
});
