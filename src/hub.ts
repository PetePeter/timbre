/**
 * Timbre's runtime: one PhoneLineService + one agent per configured phone.
 * Each phone is its own "operator session" (sessionId = phone id), so the
 * ported PhoneBridge needs no idea that several lines exist.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createOpenAiChatClient, type ChatClient } from './session/api/api-agent-loop.js';
import { PhoneLineService, type PhoneLineServiceDeps, type PhoneLineStatus } from './phone/phone-line-service.js';
import type { ConfigStore, LlmConfig, PhoneEntry } from './config/timbre-config.js';
import { validateLlm } from './config/timbre-config.js';
import { ApiAgent } from './agents/api-agent.js';
import { CliAgent, expandArgs } from './agents/cli-agent.js';
import type { PhoneAgent } from './agents/phone-agent.js';
import type { PhoneLine } from './agents/phone-tools.js';

/** What the hub needs from a line; PhoneLineService in production. */
export type HubLine = PhoneLine & {
  apply(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): PhoneLineStatus;
  restart(): Promise<void>;
  testSms(): Promise<unknown>;
};

export interface HubOptions {
  store: ConfigStore;
  dataDir: string;
  version: string;
  log: (msg: string) => void;
  /** The MCP URL a CLI agent is told to use, for a given phone. */
  mcpUrl: (phoneId: string) => string;
  /** Test seam: build the line for a phone (PhoneLineService by default). */
  createLine?: (deps: PhoneLineServiceDeps) => HubLine;
}

interface Slot { line: HubLine; agent: PhoneAgent | null; agentKey: string; token: string }

export interface PhoneStatus { id: string; name: string; llm: string; agentKind: LlmConfig['kind'] | null; agentProblem: string; line: PhoneLineStatus }

export class Hub {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly opts: HubOptions) {}

  /** Bring lines and agents in line with the saved config (start, restart, drop). */
  async apply(): Promise<void> {
    const cfg = this.opts.store.get();
    const ids = new Set(cfg.phones.map((p) => p.id));
    for (const [id, slot] of this.slots) {
      if (ids.has(id)) continue;
      slot.agent?.stop();
      await slot.line.stop();
      this.slots.delete(id);
    }
    for (const phone of cfg.phones) {
      const slot = this.slots.get(phone.id) ?? this.createSlot(phone.id);
      this.syncAgent(phone, slot);
      await slot.line.apply();
    }
  }

  async stop(): Promise<void> {
    for (const slot of this.slots.values()) { slot.agent?.stop(); await slot.line.stop(); }
    this.slots.clear();
  }

  status(): PhoneStatus[] {
    const { phones, llms } = this.opts.store.get();
    return phones.map((p) => {
      const llm = llms.find((l) => l.id === p.llmId);
      const slot = this.slots.get(p.id);
      return {
        id: p.id, name: p.name, llm: llm?.name ?? '', agentKind: slot?.agent ? llm?.kind ?? null : null,
        agentProblem: llm ? validateLlm(llm).map((f) => `${llm.name}: ${f} is required`).join('; ') : 'No LLM picked',
        line: slot?.line.getStatus() ?? emptyLineStatus(),
      };
    });
  }

  line(phoneId: string): HubLine | undefined { return this.slots.get(phoneId)?.line; }
  agent(phoneId: string): PhoneAgent | null { return this.slots.get(phoneId)?.agent ?? null; }

  /** The phone whose MCP token this is; null when it matches none. */
  phoneForToken(token: string): string | null {
    for (const [id, slot] of this.slots) if (token && slot.token === token) return id;
    return null;
  }

  private phone(id: string): PhoneEntry | undefined { return this.opts.store.get().phones.find((p) => p.id === id); }

  private createSlot(phoneId: string): Slot {
    const dir = path.join(this.opts.dataDir, 'phones', phoneId);
    const deps: PhoneLineServiceDeps = {
      getConfig: () => this.phone(phoneId)!.line,
      saveConfig: (line) => {
        const cfg = this.opts.store.get();
        this.opts.store.save({ ...cfg, phones: cfg.phones.map((p) => (p.id === phoneId ? { ...p, line } : p)) });
      },
      telefonyConfigPath: path.join(dir, 'telefony.toml'),
      defaultTranscriptDir: path.join(dir, 'transcripts'),
      getAppVersion: () => this.opts.version,
      getOperatorId: () => phoneId,
      sessionName: (id) => this.phone(id)?.name,
      deliver: async (sessionId, text) => {
        const agent = this.slots.get(sessionId)?.agent;
        if (!agent) throw new Error('No LLM is answering this phone');
        await agent.deliver(text);
      },
      log: (m) => this.opts.log(`[${this.phone(phoneId)?.name ?? phoneId}] ${m}`),
      apiModel: (llmId) => this.apiClient(llmId),
    };
    const line = this.opts.createLine?.(deps) ?? new PhoneLineService(deps);
    const slot: Slot = { line, agent: null, agentKey: '', token: randomBytes(24).toString('base64url') };
    this.slots.set(phoneId, slot);
    return slot;
  }

  private apiClient(llmId: string): ChatClient | null {
    const llm = this.opts.store.get().llms.find((l) => l.id === llmId);
    if (!llm || llm.kind !== 'api' || validateLlm(llm).length) return null;
    return createOpenAiChatClient({ baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.apiKey || undefined });
  }

  /** (Re)build the phone's agent only when its LLM or spoken name changed. */
  private syncAgent(phone: PhoneEntry, slot: Slot): void {
    const llm = this.opts.store.get().llms.find((l) => l.id === phone.llmId);
    const key = llm && !validateLlm(llm).length ? JSON.stringify([llm, phone.line.persona.name]) : '';
    if (key === slot.agentKey) return;
    slot.agent?.stop();
    slot.agent = null;
    slot.agentKey = key;
    if (!llm || !key) return;
    const log = (m: string) => this.opts.log(`[${phone.name}] ${m}`);
    if (llm.kind === 'api') {
      slot.agent = new ApiAgent({ client: this.apiClient(llm.id)!, line: slot.line, sessionId: phone.id, name: phone.line.persona.name, log });
      return;
    }
    const mcpUrl = this.opts.mcpUrl(phone.id);
    const mcpConfig = path.join(this.opts.dataDir, 'phones', phone.id, 'mcp.json');
    mkdirSync(path.dirname(mcpConfig), { recursive: true });
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { timbre: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${slot.token}` } } } }, null, 2));
    try {
      slot.agent = new CliAgent({
        command: llm.command, args: expandArgs(llm.args, { mcpUrl, mcpConfig }), cwd: llm.cwd,
        env: { TIMBRE_MCP_URL: mcpUrl, TIMBRE_MCP_TOKEN: slot.token }, log,
      });
    } catch (err) {
      log(`could not start ${llm.command}: ${(err as Error).message}`);
    }
  }
}

function emptyLineStatus(): PhoneLineStatus {
  return { enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' };
}
