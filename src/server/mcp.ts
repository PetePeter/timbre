/**
 * Minimal MCP (streamable HTTP, JSON responses) for CLI agents: just the
 * phone tools, bound to the phone whose token called. Stateless — no sessions.
 */
import { PHONE_TOOLS, phoneToolExecutor, type PhoneLine } from '../agents/phone-tools.js';

interface RpcRequest { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }

const PROTOCOL = '2025-06-18';

/** The JSON-RPC response, or null for a notification. */
export async function handleMcp(body: unknown, line: PhoneLine, phoneId: string): Promise<object | null> {
  const req = body as RpcRequest;
  if (req.id === undefined) return null;
  const ok = (result: object) => ({ jsonrpc: '2.0', id: req.id, result });
  switch (req.method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'timbre', version: '0.1.0' },
      });
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: PHONE_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
    case 'tools/call': {
      const name = String(req.params?.name ?? '');
      const text = await phoneToolExecutor(line, phoneId)(name, (req.params?.arguments ?? {}) as Record<string, unknown>);
      return ok({ content: [{ type: 'text', text }], isError: text.startsWith('Error:') });
    }
    default:
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}
