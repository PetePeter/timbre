import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface FakeMcpServerOptions {
  tools: FakeMcpTool[];
  call?: (name: string, args: Record<string, unknown>) => string;
  header?: { name: string; value: string };
  redirectTo?: string;
}

export interface FakeMcpServer {
  url: string;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  requests: number;
  deletes: number;
  close(): Promise<void>;
}

/** Small Streamable HTTP fixture for exercising the real SDK transport. */
export async function startFakeMcpServer(options: FakeMcpServerOptions): Promise<FakeMcpServer> {
  const state: FakeMcpServer = {
    url: '', calls: [], requests: 0, deletes: 0,
    close: async () => undefined,
  };
  const server: Server = createServer(async (request, response) => {
    if (request.method === 'DELETE') {
      state.deletes++;
      response.writeHead(200).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    state.requests++;
    if (options.header && request.headers[options.header.name.toLowerCase()] !== options.header.value) {
      response.writeHead(401).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body) as { id?: number | string; method: string; params?: Record<string, unknown> };
    if (!('id' in message)) {
      response.writeHead(202).end();
      return;
    }
    if (options.redirectTo) {
      response.writeHead(307, { location: options.redirectTo }).end();
      return;
    }
    let result: unknown;
    if (message.method === 'initialize') {
      const params = message.params as { protocolVersion?: string } | undefined;
      result = {
        protocolVersion: params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'timbre-test', version: '1.0.0' },
      };
    } else if (message.method === 'tools/list') {
      result = { tools: options.tools };
    } else if (message.method === 'tools/call') {
      const params = message.params as { name: string; arguments?: Record<string, unknown> };
      const args = params.arguments ?? {};
      state.calls.push({ name: params.name, args });
      result = { content: [{ type: 'text', text: options.call?.(params.name, args) ?? params.name }] };
    } else if (message.method === 'ping') {
      result = {};
    } else {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' },
      }));
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      ...(message.method === 'initialize' ? { 'mcp-session-id': 'fake-session' } : {}),
    }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake MCP server did not bind');
  state.url = `http://127.0.0.1:${address.port}/mcp`;
  state.close = () => closeServer(server);
  return state;
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

