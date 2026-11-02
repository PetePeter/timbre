import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PHONE_TOOLS } from './phone-tools.js';
import type { CliAgentOptions } from './cli-agent.js';
import { CLAUDE_CODE_EXTRA_TOOLS, normalizeClaudeCodeExtraTools } from '../config/claude-code-tools.js';
import type { CliLlm, PhoneEntry, PhoneMcpServer } from '../config/timbre-config.js';
import { buildPhoneSystemPrompt } from './phone-system-prompt.js';

interface ClaudeCodeAgentOptionsInput {
  llm: CliLlm;
  phone: PhoneEntry;
  dataDir: string;
  mcpUrl: string;
  token: string;
  log?: CliAgentOptions['log'];
}

/** Build a phone-scoped Claude Code launch and persist its restrictive settings. */
export function buildClaudeCodeAgentOptions({ llm, phone, dataDir, mcpUrl, token, log }: ClaudeCodeAgentOptionsInput): CliAgentOptions {
  const phoneDir = path.join(dataDir, 'phones', phone.id);
  const mcpConfig = path.join(phoneDir, 'mcp.json');
  const settingsPath = path.join(phoneDir, 'claude-settings.json');
  const extraTools = normalizeClaudeCodeExtraTools(llm.extraAllowedTools);
  const configured = buildClaudeCodeMcpServers(phone.mcpServers, mcpUrl, token, log);
  writeJsonFile(mcpConfig, { mcpServers: configured.servers });
  writeClaudeCodeSettings(settingsPath, extraTools, configured.allowedTools);

  const prompt = buildPhoneSystemPrompt(phone.line.persona);
  return {
    command: llm.command,
    args: [
      '--restricted',
      '--strict-mcp-config', '--mcp-config', mcpConfig,
      '--settings', settingsPath,
      '--permission-mode', 'dontAsk',
      '--tools', extraTools.join(','),
      '--append-system-prompt', prompt,
    ],
    cwd: phoneDir,
    env: {},
    log,
  };
}

interface ClaudeCodeMcpServer {
  type: 'http' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

function buildClaudeCodeMcpServers(
  clientServers: PhoneMcpServer[], mcpUrl: string, token: string, log?: CliAgentOptions['log'],
): { servers: Record<string, ClaudeCodeMcpServer>; allowedTools: string[] } {
  const servers = Object.create(null) as Record<string, ClaudeCodeMcpServer>;
  servers.timbre = { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } };
  const allowedTools: string[] = [];
  for (const server of clientServers ?? []) {
    const name = typeof server?.name === 'string' ? server.name.trim() : '';
    if (name.toLowerCase() === 'timbre') {
      log?.('Claude Code skipped reserved MCP server name: timbre');
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      log?.('Claude Code skipped MCP server with an unsupported name');
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(servers, name)) {
      log?.(`Claude Code skipped duplicate MCP server: ${name}`);
      continue;
    }
    const config = toClaudeCodeMcpServer(server);
    if (!config) {
      log?.(`Claude Code skipped invalid MCP server: ${name}`);
      continue;
    }
    servers[name] = config;
    if (server.command && server.cwd) log?.(`Claude Code MCP server ${name} ignores configured cwd`);
    const tools = Array.isArray(server.allowedTools)
      ? [...new Set(server.allowedTools.filter((tool) => typeof tool === 'string' && !!tool.trim()).map((tool) => tool.trim()))]
      : [];
    allowedTools.push(...(tools.length
      ? tools.map((tool) => `mcp__${name}__${tool}`)
      : [`mcp__${name}__*`]));
  }
  return { servers, allowedTools };
}

function toClaudeCodeMcpServer(server: PhoneMcpServer): ClaudeCodeMcpServer | null {
  const urlValue = typeof server.url === 'string' ? server.url.trim() : '';
  const command = typeof server.command === 'string' ? server.command.trim() : '';
  if (Boolean(urlValue) === Boolean(command)) return null;
  if (urlValue) {
    let url: URL;
    try { url = new URL(urlValue); } catch { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { type: 'http', url: urlValue, ...(server.headers ? { headers: { ...server.headers } } : {}) };
  }
  return {
    type: 'stdio', command,
    args: Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : [],
    ...(server.env ? { env: { ...server.env } } : {}),
  };
}

function writeClaudeCodeSettings(filePath: string, extraTools: unknown, externalTools: string[]): void {
  const selected = normalizeClaudeCodeExtraTools(extraTools);
  const selectedSet = new Set(selected);
  const settings = {
    permissions: {
      allow: [
        ...PHONE_TOOLS.map((tool) => `mcp__timbre__${tool.name}`),
        ...externalTools,
        ...selected,
      ],
      deny: CLAUDE_CODE_EXTRA_TOOLS.filter((tool) => !selectedSet.has(tool)),
    },
  };
  writeJsonFile(filePath, settings);
}

function writeJsonFile(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tempPath, filePath);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}
