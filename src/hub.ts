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
import type { ApiLlm, ConfigStore, LlmConfig, PhoneEntry } from './config/timbre-config.js';
import { validateLlm } from './config/timbre-config.js';
import { ApiAgent } from './agents/api-agent.js';
import { McpClient } from './agents/mcp-client.js';
import { DailyTokenBudget } from './agents/daily-token-budget.js';
import { CliAgent, expandArgs } from './agents/cli-agent.js';
import { ContactsStore } from './contacts/contacts-store.js';
import { projectPhoneContacts } from './phone/inbound-call-policy.js';
import type { PhoneAgent } from './agents/phone-agent.js';
import type { PhoneLine } from './agents/phone-tools.js';
import type { RecordEvent, RecordPage, RecordQueryOptions, RecordSummary } from './records/event-types.js';
import { JsonlEventStore } from './records/jsonl-event-store.js';
import { RecordQuery } from './records/record-query.js';
import { CallArtifactStore, type CallArtifacts } from './records/call-artifacts.js';
import { RecordingRetentionJob } from './records/recording-retention-job.js';

/** What the hub needs from a line; PhoneLineService in production. */
export type HubLine = PhoneLine & {
  isCallHolder(sessionId: string): boolean;
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
  /** Test seam: provide a separate model client for each phone's ApiAgent. */
  createApiClient?: (llm: ApiLlm, phoneId: string) => ChatClient;
}

interface Slot { line: HubLine; agent: PhoneAgent | null; agentKey: string; token: string }

export interface PhoneStatus { id: string; name: string; llm: string; agentKind: LlmConfig['kind'] | null; agentProblem: string; line: PhoneLineStatus }

export class Hub {
  private readonly slots = new Map<string, Slot>();
  private readonly recordStore: JsonlEventStore;
  private readonly recordQuery: RecordQuery;
  private readonly callArtifacts = new Map<string, CallArtifactStore>();
  private readonly retention: RecordingRetentionJob;

  constructor(private readonly opts: HubOptions) {
    this.recordStore = new JsonlEventStore(opts.dataDir, opts.log);
    this.recordQuery = new RecordQuery(this.recordStore);
    this.retention = new RecordingRetentionJob({
      dataDir: opts.dataDir,
      getPhones: () => this.opts.store.get().phones,
      recordEvent: (phoneId, event) => this.recordStore.append(phoneId, event),
      log: opts.log,
    });
  }

  /** Bring lines and agents in line with the saved config (start, restart, drop). */
  async apply(): Promise<void> {
    void this.retention.start().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.opts.log(`recording retention start failed: ${detail}`);
    });
    const cfg = this.opts.store.get();
    const ids = new Set(cfg.phones.map((p) => p.id));
    for (const [id, slot] of this.slots) {
      if (ids.has(id)) continue;
      await slot.agent?.stop();
      await slot.line.stop();
      this.slots.delete(id);
    }
    for (const phone of cfg.phones) this.slots.get(phone.id) ?? this.createSlot(phone.id);
    for (const phone of cfg.phones) {
      const slot = this.slots.get(phone.id)!;
      await this.syncAgent(phone, slot);
    }
    // A second pass lets earlier agents see targets that were started later in the first pass.
    for (const phone of cfg.phones) {
      const slot = this.slots.get(phone.id)!;
      await this.syncAgent(phone, slot);
      await slot.line.apply();
    }
  }

  async stop(): Promise<void> {
    await this.retention.stop();
    for (const slot of this.slots.values()) { await slot.agent?.stop(); await slot.line.stop(); }
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

  line(phoneId: string): HubLine | undefined {
    const slot = this.slots.get(phoneId);
    if (!slot) return undefined;
    const routed = this.agentLine(phoneId);
    return {
      ...routed,
      isCallHolder: (sessionId) => slot.line.isCallHolder(sessionId),
      apply: () => slot.line.apply(),
      stop: () => slot.line.stop(),
      getStatus: () => slot.line.getStatus(),
      restart: () => slot.line.restart(),
      testSms: () => slot.line.testSms(),
    };
  }
  agent(phoneId: string): PhoneAgent | null { return this.slots.get(phoneId)?.agent ?? null; }

  listRecords(phoneId: string, options: RecordQueryOptions = {}): RecordPage | null {
    if (!this.phone(phoneId)) return null;
    return this.recordQuery.list(phoneId, options);
  }

  getRecord(phoneId: string, interactionId: string): RecordSummary | null {
    if (!this.phone(phoneId)) return null;
    return this.recordQuery.get(phoneId, interactionId);
  }

  getCallArtifacts(phoneId: string, interactionId: string): CallArtifacts | null {
    if (!this.phone(phoneId)) return null;
    return this.callArtifactStore(phoneId).get(interactionId);
  }

  callRecordingPath(phoneId: string, interactionId: string): string | null {
    if (!this.phone(phoneId)) return null;
    return this.callArtifactStore(phoneId).audioPath(interactionId);
  }

  /** The phone whose MCP token this is; null when it matches none. */
  phoneForToken(token: string): string | null {
    for (const [id, slot] of this.slots) if (token && slot.token === token) return id;
    return null;
  }

  private phone(id: string): PhoneEntry | undefined { return this.opts.store.get().phones.find((p) => p.id === id); }

  private callArtifactStore(phoneId: string): CallArtifactStore {
    let store = this.callArtifacts.get(phoneId);
    if (!store) {
      store = new CallArtifactStore(this.recordingsDirectory(phoneId));
      this.callArtifacts.set(phoneId, store);
    }
    return store;
  }

  private recordingsDirectory(phoneId: string): string {
    return path.resolve(this.opts.dataDir, 'phones', phoneId, 'recordings');
  }

  private createSlot(phoneId: string): Slot {
    const dir = path.join(this.opts.dataDir, 'phones', phoneId);
    const deps: PhoneLineServiceDeps = {
      phoneId,
      getConfig: () => {
        const line = this.phone(phoneId)!.line;
        const contacts = new ContactsStore(this.opts.dataDir, phoneId, line.countryCode, this.opts.log).list();
        return { ...line, contacts: projectPhoneContacts(line, contacts) };
      },
      saveConfig: (line) => {
        const cfg = this.opts.store.get();
        this.opts.store.save({ ...cfg, phones: cfg.phones.map((p) => (p.id === phoneId ? { ...p, line } : p)) });
      },
      telefonyConfigPath: path.join(dir, 'telefony.toml'),
      recordingsDir: this.recordingsDirectory(phoneId),
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
      recordEvent: (event: RecordEvent) => this.recordStore.append(phoneId, event),
      lookupAddressBook: (number) => {
        const phone = this.phone(phoneId);
        if (!phone) return [];
        return new ContactsStore(this.opts.dataDir, phoneId, phone.line.countryCode, this.opts.log).findByNumber(number);
      },
      apiModel: (llmId) => this.apiClient(llmId),
    };
    const line = this.opts.createLine?.(deps) ?? new PhoneLineService(deps);
    const slot: Slot = { line, agent: null, agentKey: '', token: randomBytes(24).toString('base64url') };
    this.slots.set(phoneId, slot);
    return slot;
  }

  private apiClient(llmId: string, phoneId?: string): ChatClient | null {
    const llm = this.opts.store.get().llms.find((l) => l.id === llmId);
    if (!llm || llm.kind !== 'api' || validateLlm(llm).length) return null;
    if (phoneId && this.opts.createApiClient) return this.opts.createApiClient(llm, phoneId);
    return createOpenAiChatClient({ baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.apiKey || undefined });
  }

  /** (Re)build the phone's agent only when its LLM or spoken name changed. */
  private async syncAgent(phone: PhoneEntry, slot: Slot): Promise<void> {
    const cfg = this.opts.store.get();
    const llm = cfg.llms.find((l) => l.id === phone.llmId);
    const sessions = cfg.phones
      .filter((candidate) => candidate.id !== phone.id && this.slots.get(candidate.id)?.agent)
      .map(({ id, name }) => ({ id, name }));
    const key = llm && !validateLlm(llm).length
      ? JSON.stringify([llm, phone.line.persona.name, sessions, phone.mcpServers, llm.kind === 'cli' ? this.opts.mcpUrl(phone.id) : null])
      : '';
    if (key === slot.agentKey) return;
    await slot.agent?.stop();
    slot.agent = null;
    slot.agentKey = key;
    if (!llm || !key) return;
    const log = (m: string) => this.opts.log(`[${phone.name}] ${m}`);
    if (llm.kind === 'api') {
      const phoneDir = path.join(this.opts.dataDir, 'phones', phone.id);
      slot.agent = new ApiAgent({
        client: this.apiClient(llm.id, phone.id)!, line: this.agentLine(phone.id), sessionId: phone.id,
        name: phone.line.persona.name, mode: llm.mode ?? 'full', sessions,
        budget: new DailyTokenBudget(path.join(phoneDir, 'api-usage.json'), llm.dailyTokenLimit ?? 0, undefined, log), log,
        externalTools: phone.mcpServers.length ? new McpClient(phone.mcpServers, (message) => log(message)) : undefined,
      });
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

  /** Routes a transferred call back to its owning line while each phone keeps its own tools and budget. */
  private agentLine(phoneId: string): PhoneLine {
    const own = () => this.slots.get(phoneId)?.line;
    const active = (sessionId: string) => {
      for (const slot of this.slots.values()) if (slot.line.isCallHolder(sessionId)) return slot.line;
      return undefined;
    };
    return {
      sendToSession: (message) => (active(message.sessionId) ?? own())?.sendToSession(message)
        ?? Promise.resolve({ sent: false, reason: 'phone line unavailable' }),
      hangup: (sessionId) => (active(sessionId) ?? own())?.hangup(sessionId)
        ?? Promise.reject(new Error('Phone line unavailable.')),
      inbox: () => own()?.inbox() ?? Promise.resolve([]),
      startCallAgent: (sessionId, request) => (active(sessionId) ?? own())?.startCallAgent(sessionId, request)
        ?? Promise.reject(new Error('Phone line unavailable.')),
      transfer: async (from, to, line) => {
        const target = this.slots.get(to);
        if (to === from || !target?.agent || !this.phone(to)) return false;
        const source = active(from);
        if (!source) return false;
        return await source.transfer(from, to, line);
      },
      enterMessageMode: (sessionId) => active(sessionId)?.enterMessageMode(sessionId) ?? false,
    };
  }
}

function emptyLineStatus(): PhoneLineStatus {
  return { enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' };
}
