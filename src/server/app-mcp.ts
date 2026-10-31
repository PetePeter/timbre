import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createCallAction, findContacts, getRecord, InvalidCallRequestError,
  listContacts, listRecords, searchRecords, sendSmsAction,
} from '../actions/phone-actions.js';
import type { AppTokenAccess } from '../config/app-token-store.js';
import type { PhoneEntry } from '../config/timbre-config.js';
import type { Hub } from '../hub.js';
import { untrusted } from '../phone/phone-bridge.js';
import type { RecordKind, RecordQueryOptions } from '../records/event-types.js';
import type { RecordSearchIndex } from '../records/record-search-index.js';
import { v1Routes, type V1Route } from './routes/v1/contract.js';

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface AppMcpOptions {
  hub: Hub;
  phones: PhoneEntry[];
  dataDir: string;
  log: (message: string) => void;
  searchIndex: RecordSearchIndex;
}

export interface AppMcpHttpOptions extends AppMcpOptions {
  access: AppTokenAccess;
  rateLimiter: AppMcpRateLimiter;
  readJson: (req: IncomingMessage) => Promise<unknown>;
  crossOrigin: (req: IncomingMessage) => boolean;
  trackRequest: (res: ServerResponse) => void;
  send: (res: ServerResponse, status: number, body: unknown) => void;
}

interface AppTool {
  name: string;
  route: V1Route;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

const PROTOCOL = '2025-06-18';
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;
const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true, strict: false });
const validators = new WeakMap<object, ValidateFunction>();
const appTools: AppTool[] = v1Routes.map((route) => ({
  name: route.operationId.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()),
  route,
  inputSchema: toolInputSchema(route),
}));

/** Per-token fixed-window limiter for public MCP requests; returns Retry-After seconds, or zero. */
export class AppMcpRateLimiter {
  private readonly windows = new Map<string, { count: number; expiresAt: number }>();

  check(tokenId: string, now = Date.now()): number {
    const current = this.windows.get(tokenId);
    if (current && current.expiresAt > now) {
      if (current.count >= RATE_LIMIT) return Math.max(1, Math.ceil((current.expiresAt - now) / 1000));
      current.count++;
      return 0;
    }

    this.windows.set(tokenId, { count: 1, expiresAt: now + RATE_WINDOW_MS });
    if (this.windows.size > 1024) {
      for (const [id, window] of this.windows) if (window.expiresAt <= now) this.windows.delete(id);
    }
    return 0;
  }
}

/** HTTP protections and response handling for the authenticated public MCP route. */
export async function handleAppMcpHttp(req: IncomingMessage, res: ServerResponse, options: AppMcpHttpOptions): Promise<void> {
  if (req.method !== 'POST') {
    req.resume();
    options.send(res, 405, { error: 'POST only' });
    return;
  }
  if (options.crossOrigin(req)) {
    req.resume();
    options.send(res, 403, { error: 'cross-origin request refused' });
    return;
  }
  const retryAfter = options.rateLimiter.check(options.access.id);
  if (retryAfter) {
    req.resume();
    res.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(retryAfter) });
    res.end(JSON.stringify({ error: 'rate limit exceeded' }));
    return;
  }

  options.trackRequest(res);
  let body: unknown;
  try { body = await options.readJson(req); }
  catch (error) {
    req.resume();
    const tooLarge = (error as Error).message === 'body too large';
    options.send(res, tooLarge ? 413 : 400, { error: tooLarge ? 'request body too large' : 'invalid JSON body' });
    return;
  }
  const reply = await handleAppMcp(body, options, options.access);
  if (!reply) { res.writeHead(202).end(); return; }
  options.send(res, 200, reply);
}

/** The JSON-RPC response, or null for a notification. */
export async function handleAppMcp(body: unknown, options: AppMcpOptions, access: AppTokenAccess): Promise<object | null> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  }
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
      return ok({
        tools: appTools.filter((tool) => access.actions.includes(tool.route.action))
          .map(({ name, route, inputSchema }) => ({ name, description: route.summary, inputSchema })),
      });
    case 'tools/call': return ok(await callTool(req.params, options, access));
    default:
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found: ' + req.method } };
  }
}

function toolInputSchema(route: V1Route): AppTool['inputSchema'] {
  const schemas = [route.params, route.query, route.body].filter((schema): schema is AnySchema => !!schema);
  const properties = Object.assign({}, ...schemas.map((schema) =>
    (schema as { properties?: Record<string, unknown> }).properties ?? {}));
  const required = [...new Set(schemas.flatMap((schema) =>
    (schema as { required?: string[] }).required ?? []))];
  return { type: 'object', properties, required, additionalProperties: false };
}

async function callTool(params: Record<string, unknown> | undefined, options: AppMcpOptions, access: AppTokenAccess) {
  const name = typeof params?.name === 'string' ? params.name : '';
  const tool = appTools.find((item) => item.name === name);
  if (!tool) return toolError('unknown tool');
  if (!access.actions.includes(tool.route.action)) return toolError('action scope denied');

  const input = params?.arguments;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return toolError('arguments must be an object');
  const args = input as Record<string, unknown>;
  const validationError = validate(tool.inputSchema, args);
  if (validationError) return toolError('invalid arguments: ' + validationError);

  const phoneId = String(args.phoneId);
  const phone = options.phones.find((item) => item.id === phoneId);
  if (!phone) return toolError('phone not found');
  if (!access.phoneIds.includes('*') && !access.phoneIds.includes(phoneId)) return toolError('phone scope denied');

  const context = { hub: options.hub, dataDir: options.dataDir, log: options.log, searchIndex: options.searchIndex };
  try {
    const result = await execute(
      tool.route.operationId,
      tool.route.records,
      args,
      fields(tool.route.query, args),
      fields(tool.route.body, args),
      phone,
      context,
      access,
    );
    if (result.error) return toolError(result.error, result.value);
    const phoneText = tool.route.records !== undefined;
    const safeValue = phoneText ? sanitizePhoneText(result.value) : result.value;
    const text = typeof safeValue === 'string' ? safeValue : JSON.stringify(safeValue) ?? 'null';
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    const message = error instanceof InvalidCallRequestError ? error.message : (error as Error).message;
    return toolError(message || 'tool failed');
  }
}

async function execute(
  operationId: string,
  records: RecordKind | undefined,
  args: Record<string, unknown>,
  query: Record<string, unknown>,
  body: Record<string, unknown>,
  phone: PhoneEntry,
  context: { hub: Hub; dataDir: string; log: (message: string) => void; searchIndex: RecordSearchIndex },
  access: AppTokenAccess,
): Promise<{ value: unknown; error?: string }> {
  switch (operationId) {
    case 'sendSms': {
      const result = await sendSmsAction(context, phone, String(body.to), String(body.text), access.name);
      return { value: result, ...(!result.sent ? { error: result.reason ?? 'SMS not sent' } : {}) };
    }
    case 'listSms': case 'listCalls': {
      const result = listRecords(context, phone.id, records!, query as RecordQueryOptions);
      return result ? { value: result } : { value: null, error: 'phone not found' };
    }
    case 'getSms': case 'getCall': {
      const result = getRecord(context, phone.id, records!, String(args.interactionId));
      return result ? { value: result } : { value: null, error: 'record not found' };
    }
    case 'searchSms': case 'searchCalls': return { value: searchRecords(context, phone.id, records!, String(query.q ?? '')) };
    case 'listContacts': return { value: listContacts(context, phone) };
    case 'findContacts': return { value: findContacts(context, phone, String(query.number)) };
    case 'createCall':
      return { value: await createCallAction(context, phone, body, access.name) };
    default:
      return { value: null, error: 'unknown tool' };
  }
}

function fields(schema: AnySchema | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  return Object.fromEntries(Object.keys(properties).filter((key) => key in args).map((key) => [key, args[key]]));
}

function sanitizePhoneText(value: unknown): unknown {
  if (typeof value === 'string') return untrusted(value);
  if (Array.isArray(value)) return value.map(sanitizePhoneText);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizePhoneText(item)]));
  }
  return value;
}

function validate(schema: AnySchema, value: unknown): string | null {
  const existing = validators.get(schema as object);
  const validator = existing ?? ajv.compile(schema);
  if (!existing) validators.set(schema as object, validator);
  if (validator(value)) return null;
  return (validator.errors ?? []).map((error) => (error.instancePath || '/') + ' ' + (error.message ?? 'is invalid')).join('; ');
}

function toolError(message: string, value?: unknown) {
  const text = value === undefined ? message : message + ': ' + JSON.stringify(value);
  return { content: [{ type: 'text', text }], isError: true };
}
