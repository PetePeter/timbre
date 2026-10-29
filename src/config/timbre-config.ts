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
import { DEFAULT_PHONE_LINE_CONFIG, resolvePhoneLineConfig, type PhoneLineConfig } from '../phone/phone-config.js';
import { migrateLegacyPhoneContacts } from '../phone/legacy-contact-migration.js';
import { MCP_SECRET_MASK } from './mcp-secret-mask.js';
export { MCP_SECRET_MASK } from './mcp-secret-mask.js';

export type ApiLlmMode = 'handover' | 'full';
export interface ApiLlm {
  id: string; name: string; kind: 'api'; baseUrl: string; model: string; apiKey: string;
  mode?: ApiLlmMode;
  /** Zero disables the daily usage cap. */
  dailyTokenLimit?: number;
}
/** A CLI (Claude Code, Codex, …) run in a PTY; it replies through Timbre's MCP endpoint. */
export interface CliLlm { id: string; name: string; kind: 'cli'; command: string; args: string[]; cwd: string }
export type LlmConfig = ApiLlm | CliLlm;

/** An external MCP server is scoped to one phone and exposes only allowedTools. */
export interface PhoneMcpServer {
  id?: string;
  name: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  allowedTools: string[];
}

export interface PhoneEntry { id: string; name: string; llmId: string; line: PhoneLineConfig; mcpServers: PhoneMcpServer[] }

export interface WebConfig {
  port: number;
  /** Listen on every interface (phones/other PCs) instead of localhost only; needs the token. */
  lan: boolean;
  token: string;
}

export interface TimbreConfig { phones: PhoneEntry[]; llms: LlmConfig[]; web: WebConfig }

const FIRST_TELEFONY_PORT = DEFAULT_PHONE_LINE_CONFIG.port;

export function defaultConfig(): TimbreConfig {
  const llm: ApiLlm = {
    id: randomUUID(), name: 'Local model', kind: 'api', baseUrl: 'http://127.0.0.1:8080/v1', model: '', apiKey: '',
    mode: 'handover', dailyTokenLimit: 0,
  };
  return {
    llms: [llm],
    phones: [newPhone('My phone', llm.id, FIRST_TELEFONY_PORT)],
    web: { port: 7790, lan: false, token: '' },
  };
}

function newPhone(name: string, llmId: string, port: number): PhoneEntry {
  return { id: randomUUID(), name, llmId, line: { ...structuredClone(DEFAULT_PHONE_LINE_CONFIG), port }, mcpServers: [] };
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
  const llms = (raw?.llms?.length ? raw.llms : def.llms).map((llm) => llm.kind === 'api' ? {
    ...llm,
    // A missing mode is a pre-handover config and retains its old full tool access.
    mode: llm.mode === 'handover' || llm.mode === 'full' ? llm.mode : 'full',
    dailyTokenLimit: typeof llm.dailyTokenLimit === 'number' && Number.isFinite(llm.dailyTokenLimit) && llm.dailyTokenLimit >= 0
      ? Math.floor(llm.dailyTokenLimit) : 0,
  } : llm);
  const llmIds = new Set(llms.map((l) => l.id));
  const phones = (raw?.phones?.length ? raw.phones : def.phones).map((p) => ({
    ...p,
    llmId: llmIds.has(p.llmId) ? p.llmId : llms[0].id,
    line: resolvePhoneLineConfig(merge(DEFAULT_PHONE_LINE_CONFIG, p.line)),
    mcpServers: normalizeMcpServers((p as Partial<PhoneEntry>).mcpServers),
  }));
  const web = merge(def.web, raw?.web);
  if (web.lan && !web.token) web.token = randomBytes(24).toString('base64url');
  return { llms, phones, web };
}

function normalizeMcpServers(value: unknown): PhoneMcpServer[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  const ids = new Set<string>();
  const servers: PhoneMcpServer[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const server = item as Record<string, unknown>;
    const name = typeof server.name === 'string' ? server.name.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || names.has(name)) continue;
    const id = typeof server.id === 'string' && /^[\w.-]{1,100}$/.test(server.id) && !ids.has(server.id) ? server.id : randomUUID();
    const hasUrl = typeof server.url === 'string' && !!server.url.trim();
    const hasCommand = typeof server.command === 'string' && !!server.command.trim();
    if (hasUrl === hasCommand) continue;
    const allowedTools = Array.isArray(server.allowedTools)
      ? [...new Set(server.allowedTools.filter((tool): tool is string => typeof tool === 'string' && !!tool.trim()).map((tool) => tool.trim()))]
      : [];
    const strings = (input: unknown): Record<string, string> => input && typeof input === 'object' && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {};
    if (hasUrl) {
      const urlValue = (server.url as string).trim();
      let url: URL;
      try { url = new URL(urlValue); } catch { continue; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      servers.push({ id, name, url: urlValue, headers: strings(server.headers), allowedTools });
    } else {
      servers.push({
        id, name,
        command: (server.command as string).trim(),
        args: Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : [],
        ...(typeof server.cwd === 'string' ? { cwd: server.cwd } : {}),
        env: strings(server.env),
        allowedTools,
      });
    }
    ids.add(id);
    names.add(name);
  }
  return servers;
}

/** Web responses retain secret field names but never return their saved values. */
export function redactMcpSecrets(config: TimbreConfig): TimbreConfig {
  return {
    ...config,
    phones: config.phones.map((phone) => ({
      ...phone,
      mcpServers: phone.mcpServers.map((server) => ({
        ...server,
        ...(server.headers ? { headers: maskValues(server.headers) } : {}),
        ...(server.env ? { env: maskValues(server.env) } : {}),
      })),
    })),
  };
}

/** A masked web value means "keep the stored value"; omitted keys are deletions. */
export function restoreMaskedMcpSecrets(current: TimbreConfig, incoming: TimbreConfig): TimbreConfig {
  const currentPhones = new Map(current.phones.map((phone) => [phone.id, phone]));
  return {
    ...incoming,
    phones: incoming.phones.map((phone) => {
      const oldServers = currentPhones.get(phone.id)?.mcpServers ?? [];
      return {
        ...phone,
        mcpServers: phone.mcpServers.map((server) => {
          const previous = oldServers.find((candidate) => server.id && candidate.id === server.id)
            ?? oldServers.find((candidate) => candidate.name === server.name);
          return {
            ...server,
            ...(server.headers ? { headers: restoreValues(server.headers, previous?.headers) } : {}),
            ...(server.env ? { env: restoreValues(server.env, previous?.env) } : {}),
          };
        }),
      };
    }),
  };
}

function maskValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ? MCP_SECRET_MASK : '']));
}

function restoreValues(values: Record<string, string>, previous?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
    if (value !== MCP_SECRET_MASK) return [[key, value]];
    const saved = previous?.[key];
    return saved === undefined ? [] : [[key, saved]];
  }));
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
    const loaded = existsSync(file) ? YAML.parse(readFileSync(file, 'utf8')) : null;
    const migration = migrateLegacyPhoneContacts(loaded, path.dirname(file));
    this.cfg = normalizeConfig(migration.config as Partial<TimbreConfig> | null);
    if (migration.changed) this.persist();
  }

  get(): TimbreConfig { return this.cfg; }

  save(next: TimbreConfig): TimbreConfig {
    const existing = new Set(this.cfg.llms.map((llm) => llm.id));
    const withNewApiDefaults = {
      ...next,
      llms: next.llms.map((llm) => llm.kind === 'api' && !llm.mode && !existing.has(llm.id)
        ? { ...llm, mode: 'handover' as const, dailyTokenLimit: llm.dailyTokenLimit ?? 0 }
        : llm),
    };
    this.cfg = normalizeConfig(withNewApiDefaults);
    this.persist();
    return this.cfg;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const stored = structuredClone(this.cfg);
    for (const phone of stored.phones) delete (phone.line as Partial<PhoneLineConfig>).contacts;
    writeFileSync(this.file, YAML.stringify(stored));
  }
}
