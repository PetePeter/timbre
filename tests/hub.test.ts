import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliAgent } from '../src/agents/cli-agent.js';
import type { HubLine } from '../src/hub.js';
import { Hub } from '../src/hub.js';
import { addPhone, ConfigStore, defaultConfig, type CliLlm } from '../src/config/timbre-config.js';

const dirs: string[] = [];
const hubs: Hub[] = [];

async function waitForExits(logs: string[], count: number): Promise<void> {
  const end = Date.now() + 5000;
  while (logs.filter((message) => message.includes('cli agent exited')).length < count) {
    if (Date.now() >= end) throw new Error('timed out waiting for CLI PTY exits');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeLine(): HubLine {
  return {
    async apply() {},
    async stop() {},
    async restart() {},
    async testSms() { return { sent: true }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    async sendToSession() { return { sent: true }; },
    async hangup() {},
    async inbox() { return []; },
    async startCallAgent() { return {}; },
  };
}

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-hub-'));
  dirs.push(dir);
  const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
  const config = addPhone(defaultConfig(), 'Second');
  const phones = config.phones;
  const llms: CliLlm[] = ['cli-a', 'cli-b', 'cli-c'].map((id) => ({
    id,
    name: id,
    kind: 'cli',
    command: process.platform === 'win32' ? 'powershell.exe' : 'bash',
    args: process.platform === 'win32' ? ['-NoProfile', '-Command', 'Write-Output started'] : ['-c', 'echo started'],
    cwd: dir,
  }));
  store.save({
    ...config,
    llms,
    phones: phones.map((phone, i) => ({ ...phone, llmId: llms[i].id })),
  });
  let port = 7790;
  const logs: string[] = [];
  const hub = new Hub({
    store,
    dataDir: dir,
    version: 'test',
    log: (message) => logs.push(message),
    mcpUrl: (id) => 'http://127.0.0.1:' + port + '/mcp/' + id,
    createLine: () => fakeLine(),
  });
  hubs.push(hub);
  return { dir, hub, store, phones, logs, setPort: (next: number) => { port = next; } };
}

describe('Hub agent refresh', () => {
  it('rebuilds only the phone whose selected agent changes', async () => {
    const { hub, store, phones, logs } = setup();
    await hub.apply();
    await waitForExits(logs, 2);
    const [first, second] = phones;
    const firstAgent = hub.agent(first.id);
    const secondAgent = hub.agent(second.id);
    store.save({
      ...store.get(),
      phones: store.get().phones.map((phone) => phone.id === first.id ? { ...phone, llmId: 'cli-c' } : phone),
    });
    await hub.apply();
    await waitForExits(logs, 3);

    expect(hub.agent(first.id)).toBeInstanceOf(CliAgent);
    expect(hub.agent(first.id)).not.toBe(firstAgent);
    expect(hub.agent(second.id)).toBe(secondAgent);
  });

  it('refreshes CLI agents when their shared MCP port changes', async () => {
    const { hub, phones, logs, setPort } = setup();
    await hub.apply();
    await waitForExits(logs, 2);
    const firstAgent = hub.agent(phones[0].id);
    const secondAgent = hub.agent(phones[1].id);
    setPort(7791);
    await hub.apply();
    await waitForExits(logs, 4);

    expect(hub.agent(phones[0].id)).not.toBe(firstAgent);
    expect(hub.agent(phones[1].id)).not.toBe(secondAgent);
  });
});
