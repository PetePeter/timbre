import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createOpenAiChatClient, type ChatClient } from '../session/api/api-agent-loop.js';
import type { ApiLlm, ConfigStore, LlmConfig, PhoneEntry } from '../config/timbre-config.js';
import { validateLlm } from '../config/timbre-config.js';
import { ApiAgent } from './api-agent.js';
import { McpClient } from './mcp-client.js';
import { DailyTokenBudget } from './daily-token-budget.js';
import { CliAgent, expandArgs } from './cli-agent.js';
import { buildClaudeCodeAgentOptions } from './claude-code-preset.js';
import { buildCodexAgentOptions } from './codex-preset.js';
import type { PhoneAgent } from './phone-agent.js';
import type { PhoneLine } from './phone-tools.js';

interface PhoneSession { id: string; name: string }

export interface PhoneAgentFactoryOptions {
  store: ConfigStore;
  dataDir: string;
  mcpUrl: (phoneId: string) => string;
  log: (message: string) => void;
  createApiClient?: (llm: ApiLlm, phoneId: string) => ChatClient;
}

/** Owns per-phone agent identity and construction while Hub coordinates slot lifecycle. */
export class PhoneAgentFactory {
  constructor(private readonly opts: PhoneAgentFactoryOptions) {}

  key(phone: PhoneEntry, llm: LlmConfig | undefined, sessions: PhoneSession[]): string {
    if (!llm || validateLlm(llm).length) return '';
    return JSON.stringify([
      llm, sessions, phone.mcpServers, llm.kind === 'cli' ? this.opts.mcpUrl(phone.id) : null,
      llm.kind === 'cli' && (llm.preset === 'claude-code' || llm.preset === 'codex')
        ? {
          persona: phone.line.persona,
          ...(llm.preset === 'claude-code' ? { extraAllowedTools: llm.extraAllowedTools } : {}),
        }
        : null,
    ]);
  }

  apiClient(llmId: string, phoneId?: string): ChatClient | null {
    const llm = this.opts.store.get().llms.find((entry) => entry.id === llmId);
    if (!llm || llm.kind !== 'api' || validateLlm(llm).length) return null;
    if (phoneId && this.opts.createApiClient) return this.opts.createApiClient(llm, phoneId);
    return createOpenAiChatClient({
      baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.apiKey || undefined, reasoningEffort: llm.reasoningEffort,
    });
  }

  create(phone: PhoneEntry, llm: LlmConfig, token: string, sessions: PhoneSession[], line: PhoneLine): PhoneAgent | null {
    const log = (message: string) => this.opts.log(`[${phone.name}] ${message}`);
    if (llm.kind === 'api') {
      const phoneDir = path.join(this.opts.dataDir, 'phones', phone.id);
      return new ApiAgent({
        client: this.apiClient(llm.id, phone.id)!, line, sessionId: phone.id,
        name: phone.line.persona.name, mode: llm.mode ?? 'full', sessions,
        getPersona: () => {
          const persona = this.opts.store.get().phones.find((entry) => entry.id === phone.id)?.line.persona ?? phone.line.persona;
          return { name: persona.name, tone: persona.tone, instructions: persona.instructions };
        },
        budget: new DailyTokenBudget(path.join(phoneDir, 'api-usage.json'), llm.dailyTokenLimit ?? 0, undefined, log), log,
        externalTools: phone.mcpServers.length ? new McpClient(phone.mcpServers, (message) => log(message)) : undefined,
      });
    }

    const mcpUrl = this.opts.mcpUrl(phone.id);
    const mcpConfig = path.join(this.opts.dataDir, 'phones', phone.id, 'mcp.json');
    if (llm.preset !== 'claude-code') {
      mkdirSync(path.dirname(mcpConfig), { recursive: true });
      writeFileSync(mcpConfig, JSON.stringify({
        mcpServers: { timbre: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } },
      }, null, 2));
    }
    try {
      const options = llm.preset === 'claude-code'
        ? buildClaudeCodeAgentOptions({ llm, phone, dataDir: this.opts.dataDir, mcpUrl, token, log })
        : llm.preset === 'codex'
          ? buildCodexAgentOptions({ llm, phone, dataDir: this.opts.dataDir, mcpUrl, token, log })
          : {
            command: llm.command, args: expandArgs(llm.args, { mcpUrl, mcpConfig }), cwd: llm.cwd,
            env: { TIMBRE_MCP_URL: mcpUrl, TIMBRE_MCP_TOKEN: token }, log,
          };
      return new CliAgent(options);
    } catch (error) {
      log(`could not start ${llm.command}: ${(error as Error).message}`);
      return null;
    }
  }
}
