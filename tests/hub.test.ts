import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliAgent } from '../src/agents/cli-agent.js';
import { ApiAgent } from '../src/agents/api-agent.js';
import type { ChatClient, ChatMessage, CompletionResult } from '../src/session/api/api-agent-loop.js';
import type { HubLine } from '../src/hub.js';
import { Hub } from '../src/hub.js';
import { RecordingRetentionJob } from '../src/records/recording-retention-job.js';
import { addPhone, ConfigStore, defaultConfig, type ApiLlm, type CliLlm } from '../src/config/timbre-config.js';
import type { PhoneLineServiceDeps } from '../src/phone/phone-line-service.js';
import { startFakeMcpServer, type FakeMcpServer } from './helpers/fake-mcp-server.js';

const dirs: string[] = [];
const hubs: Hub[] = [];
const mcpServers: FakeMcpServer[] = [];

async function waitForExits(logs: string[], count: number): Promise<void> {
  const end = Date.now() + 5000;
  while (logs.filter((message) => message.includes('cli agent exited')).length < count) {
    if (Date.now() >= end) throw new Error('timed out waiting for CLI PTY exits');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  await Promise.all(mcpServers.splice(0).map((server) => server.close()));
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeLine(deps?: PhoneLineServiceDeps): HubLine & { sent: string[]; verifyCalls: string[]; setHolder(id: string): void } {
  let holder = '';
  const line: HubLine & { sent: string[]; verifyCalls: string[]; setHolder(id: string): void } = {
    sent: [],
    verifyCalls: [],
    setHolder(id) { holder = id; },
    async apply() {},
    async stop() {},
    async restart() {},
    async testSms() { return { sent: true }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    async sendToSession(message) { line.sent.push(message.text); return { sent: true }; },
    async hangup() {},
    async inbox() { return []; },
    async startCallAgent() { return {}; },
    async verifyCaller(id) { line.verifyCalls.push(id); return 'Caller verified.'; },
    isCallerVerified() { return true; },
    isCallHolder(id) { return holder === id; },
    transfer(from, to, intro) {
      if (holder !== from) return false;
      holder = to;
      void deps?.deliver(to, `[PHONE] ${intro}`);
      return true;
    },
    enterMessageMode() { return false; },
  };
  return line;
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
  const lineDeps: PhoneLineServiceDeps[] = [];
  const hub = new Hub({
    store,
    dataDir: dir,
    version: 'test',
    log: (message) => logs.push(message),
    mcpUrl: (id) => 'http://127.0.0.1:' + port + '/mcp/' + id,
    createLine: (deps) => { lineDeps.push(deps); return fakeLine(deps); },
  });
  hubs.push(hub);
  return { dir, hub, store, phones, logs, lineDeps, setPort: (next: number) => { port = next; } };
}

describe('Hub agent refresh', () => {
  it('does not await the first retention sweep and logs its failure', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-hub-retention-start-'));
    dirs.push(dir);
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    store.save(defaultConfig());
    const logs: string[] = [];
    const hub = new Hub({
      store, dataDir: dir, version: 'test', log: (message) => logs.push(message), mcpUrl: () => '',
      createLine: (deps) => fakeLine(deps),
    });
    hubs.push(hub);
    let rejectSweep!: (error: Error) => void;
    const pendingSweep = new Promise<void>((_resolve, reject) => { rejectSweep = reject; });
    vi.spyOn(RecordingRetentionJob.prototype, 'start').mockReturnValue(pendingSweep);

    const applying = hub.apply().then(() => 'completed', () => 'rejected');
    const result = await Promise.race([
      applying,
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);
    rejectSweep(new Error('disk unavailable'));
    if (result === 'blocked') await applying;
    await Promise.resolve();

    expect(result).toBe('completed');
    expect(logs).toContain('recording retention start failed: disk unavailable');
  });

  it('runs the retention purge on apply for a disabled phone and stores its event', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-hub-retention-'));
    dirs.push(dir);
    const config = defaultConfig();
    const phone = config.phones[0];
    phone.line.enabled = false;
    phone.line.recordings.retentionDays = 30;
    phone.line.transcripts.retentionDays = 60;
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    store.save(config);
    const audio = path.join(dir, 'phones', phone.id, 'recordings', 'expired.wav');
    mkdirSync(path.dirname(audio), { recursive: true });
    writeFileSync(audio, 'audio');
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(audio, old, old);
    const hub = new Hub({
      store, dataDir: dir, version: 'test', log: () => undefined, mcpUrl: () => '',
      createLine: (deps) => fakeLine(deps),
    });
    hubs.push(hub);

    await hub.apply();
    for (let attempt = 0; !hub.listRecords(phone.id)?.items[0]?.events.some((event) => event.type === 'retention.purged') && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(existsSync(audio)).toBe(false);
    expect(hub.listRecords(phone.id)?.items[0].events[0]).toMatchObject({
      kind: 'system', type: 'retention.purged', details: { recordingsRemoved: 1, transcriptsRemoved: 0 },
    });
  });

  it('derives each recordings directory from dataDir', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-hub-recordings-'));
    dirs.push(dir);
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    const phones = addPhone(defaultConfig(), 'Second').phones;
    store.save({ ...defaultConfig(), phones });
    const lineDeps: PhoneLineServiceDeps[] = [];
    const hub = new Hub({
      store, dataDir: dir, version: 'test', log: () => undefined, mcpUrl: () => '',
      createLine: (deps) => { lineDeps.push(deps); return fakeLine(deps); },
    });
    hubs.push(hub);
    await hub.apply();

    expect(lineDeps.map((deps) => deps.recordingsDir)).toEqual(
      phones.map((phone) => path.resolve(dir, 'phones', phone.id, 'recordings')),
    );
  });

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

  it('routes a transferred call through the receiving phone agent back to its source line', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-hub-transfer-'));
    dirs.push(dir);
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    let cfg = addPhone(defaultConfig(), 'Desk');
    const api: ApiLlm = {
      id: 'api', name: 'API', kind: 'api', baseUrl: 'http://127.0.0.1/v1', model: 'm', apiKey: '',
      mode: 'handover', dailyTokenLimit: 0,
    };
    cfg = { ...cfg, llms: [api], phones: cfg.phones.map((phone) => ({ ...phone, llmId: api.id })) };
    store.save(cfg);
    const [phone, desk] = cfg.phones;
    const clients = new Map<string, ChatClient>();
    const lines: Array<HubLine & { sent: string[]; setHolder(id: string): void }> = [];
    const hub = new Hub({
      store, dataDir: dir, version: 'test', log: () => undefined, mcpUrl: () => '',
      createLine: (deps) => { const line = fakeLine(deps); lines.push(line); return line; },
      createApiClient: (_llm, phoneId) => {
        let round = 0;
        const client: ChatClient = {
          async complete(_messages: ChatMessage[], tools) {
            const currentRound = round++;
            if (phoneId === phone.id && currentRound > 0) return { message: { content: 'done' } };
            if (phoneId === desk.id && currentRound > 1) return { message: { content: 'done' } };
            const name = phoneId === phone.id ? 'call_transfer' : currentRound === 0 ? 'verify_caller' : 'chat_send';
            const tool = tools.find((item) => item.name === name)!;
            const args = phoneId === phone.id
              ? { sessionId: desk.id, line: 'Desk will take it.' }
              : currentRound === 0 ? {} : { text: 'Hello, Desk here.' };
            const result: CompletionResult = {
              message: { content: null, tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
            };
            return result;
          },
        };
        clients.set(phoneId, client);
        return client;
      },
    });
    hubs.push(hub);
    await hub.apply();
    lines[0].setHolder(phone.id);
    const first = hub.agent(phone.id) as ApiAgent;
    await first.deliver('please connect me');
    await first.idle();
    await (hub.agent(desk.id) as ApiAgent).idle();
    expect(lines[0].verifyCalls).toEqual([desk.id]);
    expect(lines[0].sent).toEqual(['Hello, Desk here.']);
    expect(clients.size).toBe(2);
  });

  it('offers and accepts transfers only for phones with a running agent', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-hub-answerable-'));
    dirs.push(dir);
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    const cfg = addPhone(defaultConfig(), 'Unanswerable');
    const [source, target] = cfg.phones;
    store.save({
      ...cfg,
      llms: [
        { id: 'api', name: 'API', kind: 'api', baseUrl: 'http://127.0.0.1/v1', model: 'm', apiKey: '', mode: 'handover', dailyTokenLimit: 0 },
        { id: 'invalid', name: 'Invalid', kind: 'api', baseUrl: '', model: '', apiKey: '' },
      ],
      phones: [
        { ...source, llmId: 'api' },
        { ...target, llmId: 'invalid' },
      ],
    });
    const lines: Array<ReturnType<typeof fakeLine>> = [];
    let advertised: string[] = [];
    const hub = new Hub({
      store, dataDir: dir, version: 'test', log: () => undefined, mcpUrl: () => '',
      createLine: (deps) => { const line = fakeLine(deps); lines.push(line); return line; },
      createApiClient: () => ({
        async complete(_messages, tools) {
          advertised = tools.map((tool) => tool.name);
          return { message: { content: 'ready' } };
        },
      }),
    });
    hubs.push(hub);
    await hub.apply();
    await (hub.agent(source.id) as ApiAgent).deliver('hello');
    await (hub.agent(source.id) as ApiAgent).idle();
    lines[0].setHolder(source.id);

    expect(advertised).not.toContain('call_transfer');
    await expect(hub.line(source.id)!.transfer(source.id, target.id, 'Take this call.')).resolves.toBe(false);
    expect(lines[0].isCallHolder(source.id)).toBe(true);
  });

  it('keeps each API phone connected only to its own configured MCP server', async () => {
    const firstServer = await startFakeMcpServer({
      tools: [{ name: 'echo', description: 'first phone only', inputSchema: { type: 'object' } }],
      call: () => 'result-from-first-phone',
    });
    const secondServer = await startFakeMcpServer({
      tools: [{ name: 'echo', description: 'second phone only', inputSchema: { type: 'object' } }],
      call: () => 'result-from-second-phone',
    });
    mcpServers.push(firstServer, secondServer);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-hub-mcp-'));
    dirs.push(dir);
    const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
    const api: ApiLlm = {
      id: 'api', name: 'API', kind: 'api', baseUrl: 'http://127.0.0.1/v1', model: 'm', apiKey: '',
      mode: 'full', dailyTokenLimit: 0,
    };
    const cfg = addPhone(defaultConfig(), 'Second');
    const phones = cfg.phones;
    store.save({
      ...cfg,
      llms: [api],
      phones: phones.map((phone, index) => ({
        ...phone,
        llmId: api.id,
        mcpServers: [{
          name: index === 0 ? 'first' : 'second',
          url: index === 0 ? firstServer.url : secondServer.url,
          allowedTools: ['echo'],
        }],
      })),
    });
    const observed = new Map<string, { external: string; result: string }>();
    const hub = new Hub({
      store, dataDir: dir, version: 'test', log: () => undefined, mcpUrl: () => '',
      createLine: (deps) => fakeLine(deps),
      createApiClient: (_llm, phoneId) => {
        let round = 0;
        return {
          async complete(messages, tools) {
            if (round++ === 0) {
              const external = tools.find((tool) => tool.name.startsWith('mcp_'))!;
              observed.set(phoneId, { external: external.name, result: '' });
              return {
                message: { content: null, tool_calls: [{
                  id: external.name, type: 'function', function: { name: external.name, arguments: '{}' },
                }] },
              };
            }
            const previous = observed.get(phoneId)!;
            const result = messages.filter((message) => message.role === 'tool').at(-1)?.content ?? '';
            observed.set(phoneId, { ...previous, result });
            return { message: { content: 'done' } };
          },
        };
      },
    });
    hubs.push(hub);
    await hub.apply();
    for (const phone of phones) {
      const agent = hub.agent(phone.id) as ApiAgent;
      await agent.deliver('check your MCP server');
      await agent.idle();
    }
    expect(observed.get(phones[0].id)).toMatchObject({ external: expect.stringContaining('mcp_first_echo'), result: 'result-from-first-phone' });
    expect(observed.get(phones[1].id)).toMatchObject({ external: expect.stringContaining('mcp_second_echo'), result: 'result-from-second-phone' });
    expect(firstServer.calls.map((call) => call.name)).toEqual(['echo']);
    expect(secondServer.calls.map((call) => call.name)).toEqual(['echo']);
    await hub.stop();
    expect(firstServer.deletes).toBeGreaterThan(0);
    expect(secondServer.deletes).toBeGreaterThan(0);
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
