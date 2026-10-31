import { randomUUID } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliAgentOptions } from './cli-agent.js';
import type { CliLlm, PhoneEntry } from '../config/timbre-config.js';
import { buildPhoneSystemPrompt } from './phone-system-prompt.js';

interface CodexAgentOptionsInput {
  llm: CliLlm;
  phone: PhoneEntry;
  dataDir: string;
  mcpUrl: string;
  token: string;
  log?: CliAgentOptions['log'];
}

/** Build a Codex CLI launch with one phone-scoped MCP server and an isolated home. */
export function buildCodexAgentOptions({ llm, phone, dataDir, mcpUrl, token, log }: CodexAgentOptionsInput): CliAgentOptions {
  const phoneDir = path.join(dataDir, 'phones', phone.id);
  const codexHome = path.join(phoneDir, 'codex-home');
  const workspace = path.join(codexHome, 'workspace');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  writeCodexConfig(path.join(codexHome, 'config.toml'), {
    projectDir: workspace,
    mcpUrl,
    persona: phone.line.persona,
  });
  const scriptPath = path.join(codexHome, 'launch-codex.ps1');
  if (process.platform === 'win32') writeCodexLauncher(scriptPath, llm.command);

  return {
    command: process.platform === 'win32' ? 'powershell.exe' : llm.command,
    args: process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
      : ['--strict-config', '--sandbox', 'read-only'],
    cwd: workspace,
    env: { CODEX_HOME: codexHome, TIMBRE_MCP_TOKEN: token },
    beforeSpawn: () => copyAuthIfNewer(codexHome, userCodexHome()),
    log,
  };
}

function userCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return path.resolve(configured || path.join(os.homedir(), '.codex'));
}

function copyAuthIfNewer(codexHome: string, sourceHome: string): void {
  const source = path.join(sourceHome, 'auth.json');
  const target = path.join(codexHome, 'auth.json');
  if (samePath(source, target) || !existsSync(source)) return;

  const sourceStat = statSync(source);
  if (!sourceStat.isFile()) throw new Error('Codex auth.json must be a file.');
  const targetStat = existsSync(target) ? statSync(target) : null;
  if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs) return;

  const tempPath = path.join(codexHome, `.auth.${process.pid}.${randomUUID()}.tmp`);
  try {
    copyFileSync(source, tempPath);
    chmodSync(tempPath, 0o600);
    utimesSync(tempPath, sourceStat.atime, sourceStat.mtime);
    renameSync(tempPath, target);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function writeCodexConfig(filePath: string, { projectDir, mcpUrl, persona }: {
  projectDir: string;
  mcpUrl: string;
  persona: PhoneEntry['line']['persona'];
}): void {
  const config = [
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'cli_auth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    'web_search = "disabled"',
    `developer_instructions = ${tomlString(buildPhoneSystemPrompt(persona))}`,
    '',
    '[features]',
    'shell_tool = false',
    'multi_agent = false',
    'apps = false',
    'plugins = false',
    'hooks = false',
    'goals = false',
    'memories = false',
    'browser_use = false',
    'computer_use = false',
    'skill_mcp_dependency_install = false',
    '',
    `[projects.${tomlString(projectDir)}]`,
    'trust_level = "trusted"',
    '',
    '[mcp_servers.timbre]',
    `url = ${tomlString(mcpUrl)}`,
    'bearer_token_env_var = "TIMBRE_MCP_TOKEN"',
    'required = true',
    'default_tools_approval_mode = "approve"',
    '',
  ].join('\n');

  writeAtomicText(filePath, config);
}

function writeCodexLauncher(filePath: string, command: string): void {
  if (/[\0\r\n]/.test(command)) throw new Error('Codex command cannot contain line breaks.');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `& ${powershellString(command)} '--strict-config' '--sandbox' 'read-only'`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
  writeAtomicText(filePath, script);
}

function writeAtomicText(filePath: string, text: string): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, text, { flag: 'wx', mode: 0o600 });
    renameSync(tempPath, filePath);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** JSON basic strings use the same escapes as TOML and safely quote paths/prompts. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}
