/**
 * Timbre settings: the phones (one telefony-app line each), the LLMs that
 * answer them, and who may reach the web UI. Pure helpers plus one YAML store;
 * the store is the only writer, so every save passes `normalizeConfig`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { DEFAULT_PHONE_LINE_CONFIG, type PhoneLineConfig } from '../phone/phone-config.js';

export interface ApiLlm { id: string; name: string; kind: 'api'; baseUrl: string; model: string; apiKey: string }
/** A CLI (Claude Code, Codex, …) run in a PTY; it replies through Timbre's MCP endpoint. */
export interface CliLlm { id: string; name: string; kind: 'cli'; command: string; args: string[]; cwd: string }
export type LlmConfig = ApiLlm | CliLlm;

export interface PhoneEntry { id: string; name: string; llmId: string; line: PhoneLineConfig }

export interface WebConfig {
  port: number;
  /** Listen on every interface (phones/other PCs) instead of localhost only; needs the token. */
  lan: boolean;
  token: string;
}

export interface TimbreConfig { phones: PhoneEntry[]; llms: LlmConfig[]; web: WebConfig }

const FIRST_TELEFONY_PORT = DEFAULT_PHONE_LINE_CONFIG.port;

export function defaultConfig(): TimbreConfig {
  const llm: ApiLlm = { id: randomUUID(), name: 'Local model', kind: 'api', baseUrl: 'http://127.0.0.1:8080/v1', model: '', apiKey: '' };
  return {
    llms: [llm],
    phones: [newPhone('My phone', llm.id, FIRST_TELEFONY_PORT)],
    web: { port: 7790, lan: false, token: '' },
  };
}

function newPhone(name: string, llmId: string, port: number): PhoneEntry {
  return { id: randomUUID(), name, llmId, line: { ...structuredClone(DEFAULT_PHONE_LINE_CONFIG), port } };
}

export function addPhone(cfg: TimbreConfig, name: string): TimbreConfig {
  const port = Math.max(FIRST_TELEFONY_PORT - 1, ...cfg.phones.map((p) => p.line.port)) + 1;
  return { ...cfg, phones: [...cfg.phones, newPhone(name, cfg.llms[0]?.id ?? '', port)] };
}

export function removePhone(cfg: TimbreConfig, id: string): TimbreConfig {
  if (cfg.phones.length <= 1) throw new Error('Cannot remove the last phone');
  return { ...cfg, phones: cfg.phones.filter((p) => p.id !== id) };
}

/** Field names that stop this LLM from running; empty = usable. */
export function validateLlm(llm: LlmConfig): string[] {
  if (llm.kind === 'api') return [!llm.baseUrl.trim() && 'baseUrl', !llm.model.trim() && 'model'].filter(Boolean) as string[];
  return llm.command.trim() ? [] : ['command'];
}

/** Defaults under `base`, `over` on top; arrays replace rather than merge. */
function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over) || !base || typeof base !== 'object' || Array.isArray(base)) {
    return (over === undefined ? base : over) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = merge((base as Record<string, unknown>)[k], v);
  return out as T;
}

export function normalizeConfig(raw: Partial<TimbreConfig> | null | undefined): TimbreConfig {
  const def = defaultConfig();
  const llms = raw?.llms?.length ? raw.llms : def.llms;
  const llmIds = new Set(llms.map((l) => l.id));
  const phones = (raw?.phones?.length ? raw.phones : def.phones).map((p) => ({
    ...p,
    llmId: llmIds.has(p.llmId) ? p.llmId : llms[0].id,
    line: merge(DEFAULT_PHONE_LINE_CONFIG, p.line),
  }));
  const web = merge(def.web, raw?.web);
  if (web.lan && !web.token) web.token = randomBytes(24).toString('base64url');
  return { llms, phones, web };
}

/** Per-user data dir on every OS; never the repo. */
export function dataDir(): string {
  if (process.env.TIMBRE_HOME) return process.env.TIMBRE_HOME;
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? os.homedir(), 'Timbre');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Timbre');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'timbre');
}

export class ConfigStore {
  private cfg: TimbreConfig;

  constructor(private readonly file: string) {
    this.cfg = normalizeConfig(existsSync(file) ? YAML.parse(readFileSync(file, 'utf8')) : null);
  }

  get(): TimbreConfig { return this.cfg; }

  save(next: TimbreConfig): TimbreConfig {
    this.cfg = normalizeConfig(next);
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, YAML.stringify(this.cfg));
    return this.cfg;
  }
}
