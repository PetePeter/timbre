import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClient } from '../src/agents/mcp-client.js';
import { startFakeMcpServer } from './helpers/fake-mcp-server.js';

const servers: Array<{ close(): Promise<void> }> = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-mcp-'));
  dirs.push(dir);
  return dir;
}

describe('McpClient', () => {
  it('lists only configured tools with safe names and calls through Streamable HTTP', async () => {
    const server = await startFakeMcpServer({
      tools: [
        { name: 'echo', description: '{caller data}', inputSchema: { type: 'object', properties: { text: { type: 'string', description: '{required data}' } } } },
        { name: 'erase', description: 'never allowed', inputSchema: { type: 'object' } },
      ],
      header: { name: 'x-api-key', value: 'secret-header-value' },
      call: (_name, args) => `echo:${String(args.text)}`,
    });
    servers.push(server);
    const client = new McpClient([{ name: 'tasks', url: server.url, headers: { 'x-api-key': 'secret-header-value' }, allowedTools: ['echo'] }]);
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toMatch(/^mcp_tasks_echo_[a-f0-9]+$/);
    expect(tools[0].name.length).toBeLessThanOrEqual(64);
    expect(tools[0].description).toContain('(caller data)');
    expect((tools[0].parameters.properties as Record<string, { description: string }>).text.description).toBe('(required data)');
    await expect(client.callTool(tools[0].name, { text: 'hi' })).resolves.toBe('echo:hi');
    expect(server.calls).toEqual([{ name: 'echo', args: { text: 'hi' } }]);
    await expect(client.callTool('mcp_tasks_erase_deadbeef', {})).rejects.toThrow(/not allowed/i);
    expect(server.calls).toHaveLength(1);
    await client.close();
  });

  it('uses configured stdio env, discards server stderr, and closes the process', async () => {
    const dir = tempDir();
    const script = path.join(dir, 'server.mjs');
    const marker = path.join(dir, 'closed.txt');
    writeFileSync(script, [
      "import { createInterface } from 'node:readline';",
      "import { writeFileSync } from 'node:fs';",
      "process.on('exit', () => writeFileSync(process.env.MCP_CLOSE_MARKER, 'closed'));",
      "process.stderr.write('STDIO_SECRET_SHOULD_NOT_BE_LOGGED\\n');",
      "const tools = [{ name: 'read_env', description: 'read the configured environment', inputSchema: { type: 'object' } }];",
      "const lines = createInterface({ input: process.stdin });",
      "lines.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.id === undefined) return;",
      "  let result = {};",
      "  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stdio-test', version: '1' } };",
      "  else if (message.method === 'tools/list') result = { tools };",
      "  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: process.env.MCP_TEST_VALUE }] };",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');",
      '});',
    ].join('\n'));
    const logs: string[] = [];
    const client = new McpClient([{
      name: 'local', command: process.execPath, args: [script], cwd: dir,
      env: { MCP_TEST_VALUE: 'stdio-result', MCP_CLOSE_MARKER: marker }, allowedTools: ['read_env'],
    }], (message) => logs.push(message));
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    await expect(client.callTool(tools[0].name, {})).resolves.toBe('stdio-result');
    await client.close();
    expect(readFileSync(marker, 'utf8')).toBe('closed');
    expect(logs.join('\n')).not.toContain('STDIO_SECRET_SHOULD_NOT_BE_LOGGED');
  });

  it('does not follow HTTP redirects or disclose configured headers, and keeps failures generic', async () => {
    const target = await startFakeMcpServer({ tools: [{ name: 'leak', inputSchema: { type: 'object' } }] });
    servers.push(target);
    const redirect = await startFakeMcpServer({ tools: [], redirectTo: target.url });
    servers.push(redirect);
    const logs: string[] = [];
    const client = new McpClient([{
      name: 'private', url: redirect.url, headers: { authorization: 'secret-header-value' }, allowedTools: ['leak'],
    }], (message) => logs.push(message));
    expect(await client.listTools()).toEqual([]);
    await client.close();
    expect(target.requests).toBe(0);
    expect(logs.join('\n')).not.toContain('secret-header-value');
    expect(logs.join('\n')).not.toContain('authorization');
  });
});
