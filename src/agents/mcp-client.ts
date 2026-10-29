import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { PhoneMcpServer } from '../config/timbre-config.js';
import { untrusted } from '../phone/phone-bridge.js';
import type { ToolSpec } from '../session/api/api-agent-loop.js';
import type { ExternalToolProvider } from './api-agent.js';

type McpTransport = StreamableHTTPClientTransport | StdioClientTransport;
interface Connection { client: Client; transport: McpTransport }
interface ToolBinding { server: PhoneMcpServer; remoteName: string }

/** One isolated set of external MCP connections for one API phone agent. */
export class McpClient implements ExternalToolProvider {
  private readonly connections = new Map<string, Connection>();
  private readonly advertised = new Map<string, ToolBinding>();
  private closed = false;

  constructor(
    private readonly servers: PhoneMcpServer[],
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async listTools(): Promise<ToolSpec[]> {
    if (this.closed) return [];
    this.advertised.clear();
    const result: ToolSpec[] = [];
    for (const server of this.servers) {
      const allowed = new Set(server.allowedTools);
      if (!allowed.size) continue;
      try {
        const client = await this.connect(server);
        const listed = await client.listTools();
        for (const remote of listed.tools) {
          if (!remote.name || !allowed.has(remote.name)) continue;
          const name = mcpFunctionName(server.name, remote.name);
          if (this.advertised.has(name)) continue;
          const schema = remote.inputSchema && typeof remote.inputSchema === 'object'
            ? safeDescriptions(remote.inputSchema) as Record<string, unknown>
            : { type: 'object' };
          this.advertised.set(name, { server, remoteName: remote.name });
          result.push({
            name,
            description: untrusted(remote.description ?? `External MCP tool from ${server.name}.`),
            parameters: schema,
          });
        }
      } catch {
        this.log(`MCP server ${server.name} unavailable`);
        await this.disconnect(server.name);
      }
    }
    return result;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const binding = this.advertised.get(name);
    if (this.closed || !binding || !binding.server.allowedTools.includes(binding.remoteName)) {
      throw new Error('External MCP tool is not allowed.');
    }
    try {
      const client = await this.connect(binding.server);
      const result = await client.callTool({ name: binding.remoteName, arguments: args });
      if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
      const text = result.content.flatMap((block) => 'text' in block && typeof block.text === 'string' ? [block.text] : []);
      if (text.length) return text.join('\n');
      return result.isError ? 'The external MCP tool reported an error.' : 'The external MCP tool returned no text.';
    } catch {
      await this.disconnect(binding.server.name);
      throw new Error('External MCP tool call failed.');
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.advertised.clear();
    await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)));
  }

  private async connect(server: PhoneMcpServer): Promise<Client> {
    const active = this.connections.get(server.name);
    if (active) return active.client;
    if (this.closed) throw new Error('MCP client is closed.');

    const transport = createTransport(server);
    const client = new Client({ name: 'timbre-phone', version: '1.0.0' });
    const connection = { client, transport };
    try {
      await client.connect(transport);
    } catch {
      await closeConnection(connection);
      throw new Error('MCP connection failed.');
    }
    this.connections.set(server.name, connection);
    return client;
  }

  private async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    this.connections.delete(name);
    await closeConnection(connection);
  }
}

function createTransport(server: PhoneMcpServer): McpTransport {
  if (server.url) {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers, redirect: 'error' },
      redirectPolicy: 'same-origin',
    });
  }
  if (server.command) {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: server.env,
      stderr: 'ignore',
    });
  }
  throw new Error('MCP transport is not configured.');
}

async function closeConnection(connection: Connection): Promise<void> {
  if (connection.transport instanceof StreamableHTTPClientTransport) {
    try { await connection.transport.terminateSession(); } catch { /* Server may already be gone. */ }
  }
  try { await connection.client.close(); } catch { /* Cleanup is best effort. */ }
}

function mcpFunctionName(server: string, tool: string): string {
  const readable = `${server}_${tool}`.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 10);
  return `mcp_${(readable || 'tool').slice(0, 49)}_${hash}`;
}

/** Tool schema descriptions are model-facing external data too. */
function safeDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === 'description' && typeof item === 'string' ? untrusted(item) : safeDescriptions(item),
  ]));
}

