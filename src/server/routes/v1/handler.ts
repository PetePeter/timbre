import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppTokenAccess } from '../../../config/app-token-store.js';
import type { PhoneEntry } from '../../../config/timbre-config.js';
import type { CallSkill } from '../../../config/call-skills.js';
import type { Hub } from '../../../hub.js';
import type { RecordSearchIndex } from '../../../records/record-search-index.js';
import type { AppCallDesk } from '../../../phone/app-call-desk.js';
import type { LiveCallStreamRegistry } from '../live-calls.js';
import { matchV1Route, matchesV1Path } from './contract.js';
import { executeV1Operation } from './operations.js';

export interface V1HandlerOptions {
  hub: Hub;
  phones: PhoneEntry[];
  callSkills: CallSkill[];
  dataDir: string;
  log: (message: string) => void;
  searchIndex: RecordSearchIndex;
  readJson: (req: IncomingMessage) => Promise<unknown>;
  /** Lets server shutdown close open SSE streams. */
  streams?: LiveCallStreamRegistry;
}

const HEARTBEAT_MS = 20_000;
const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true, strict: false });
const validators = new WeakMap<object, ValidateFunction>();

export async function handleV1Request(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: V1HandlerOptions,
  access: AppTokenAccess,
): Promise<boolean> {
  const matched = matchV1Route(req.method ?? '', url.pathname);
  if (!matched) return json(res, matchesV1Path(url.pathname) ? 405 : 404, { error: matchesV1Path(url.pathname) ? 'method not allowed' : 'not found' });
  const { route, params } = matched;
  const paramErrors = validate(route.params, params);
  if (paramErrors) return json(res, 400, { error: 'invalid request', details: paramErrors });

  let phone: PhoneEntry | undefined;
  if (route.scope === 'app') {
    if (route.action && !access.actions.includes(route.action)) return json(res, 403, { error: 'action scope denied' });
  } else {
    phone = options.phones.find((item) => item.id === params.phoneId);
    if (!phone) return json(res, 404, { error: 'phone not found' });
    if (!access.phoneIds.includes('*') && !access.phoneIds.includes(phone.id)) return json(res, 403, { error: 'phone scope denied' });
    if (route.action && !access.actions.includes(route.action)) return json(res, 403, { error: 'action scope denied' });
  }

  const parsedQuery = queryValues(url);
  if (parsedQuery.duplicate) return json(res, 400, { error: 'duplicate query parameter' });
  const query = parsedQuery.values;
  const queryErrors = validate(route.query, query);
  if (queryErrors) return json(res, 400, { error: 'invalid request', details: queryErrors });

  let body: unknown;
  if (route.body) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'application/json required' });
    try { body = await options.readJson(req); }
    catch { return json(res, 400, { error: 'invalid JSON body' }); }
    const bodyErrors = validate(route.body, body);
    if (bodyErrors) return json(res, 400, { error: 'invalid request', details: bodyErrors });
  }

  if (route.stream && phone) {
    streamAppCalls(req, res, options.hub.appCalls(phone.id), access.id, options.streams);
    return true;
  }
  const context = {
    hub: options.hub, phones: options.phones, callSkills: options.callSkills,
    dataDir: options.dataDir, log: options.log, searchIndex: options.searchIndex,
  };
  const result = await executeV1Operation(route, context, phone, access, {
    params, query, body: (body ?? {}) as Record<string, unknown>,
  });
  return json(res, result.status, result.body);
}

/** SSE of the phone's live inbound-call events; an open stream counts as a subscribed app. */
function streamAppCalls(req: IncomingMessage, res: ServerResponse, desk: AppCallDesk, tokenId: string, streams?: LiveCallStreamRegistry): void {
  let closed = false;
  let unregister = () => {};
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    unregister();
    if (!res.writableEnded) res.end();
  };
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const unsubscribe = desk.subscribe(({ seq, event }) => {
    if (!closed) res.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => { if (!closed) res.write(': keepalive\n\n'); }, HEARTBEAT_MS);
  if (streams) unregister = streams.register(finish);
  res.once('close', finish);
  req.once('aborted', finish);
}

function validate(schema: AnySchema | undefined, value: unknown): Array<{ path: string; message: string }> | null {
  if (!schema) return null;
  const existing = validators.get(schema as object);
  const validator = existing ?? ajv.compile(schema);
  if (!existing) validators.set(schema as object, validator);
  if (validator(value)) return null;
  return (validator.errors ?? []).map((error) => ({ path: error.instancePath, message: error.message ?? 'invalid value' }));
}

function queryValues(url: URL): { values: Record<string, string>; duplicate: boolean } {
  const query: Record<string, string> = {};
  let duplicate = false;
  for (const [key, value] of url.searchParams) {
    if (key in query) duplicate = true;
    query[key] = value;
  }
  return { values: query, duplicate };
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

