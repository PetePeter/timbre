import { Ajv } from 'ajv';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_ACTIONS, AppTokenInputError, AppTokenStore } from '../../config/app-token-store.js';
import type { PhoneEntry } from '../../config/timbre-config.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const validateInput = ajv.compile({
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    phoneIds: { type: 'array', minItems: 1, maxItems: 1, items: { anyOf: [{ const: '*' }, { type: 'string', pattern: '^[\\w-]{1,128}$' }] } },
    actions: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...APP_ACTIONS] } },
  },
  required: ['name', 'phoneIds', 'actions'],
});

export type AppTokenRoute = { action: 'collection' } | { action: 'token'; id: string };

export function matchAppTokenRoute(pathname: string): AppTokenRoute | null {
  if (pathname === '/api/app-tokens') return { action: 'collection' };
  const match = /^\/api\/app-tokens\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
  return match ? { action: 'token', id: match[1] } : null;
}

export async function handleAppTokenRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: AppTokenRoute,
  options: { store: AppTokenStore; phones: PhoneEntry[]; readJson: (req: IncomingMessage) => Promise<unknown> },
): Promise<boolean> {
  if (route.action === 'collection' && req.method === 'GET') return json(res, 200, { items: options.store.list() });
  if (route.action === 'collection' && req.method === 'POST') {
    let body: unknown;
    try { body = await options.readJson(req); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    if (!validateInput(body)) return json(res, 400, { error: 'invalid token configuration' });
    const input = body as { name: string; phoneIds: string[]; actions: typeof APP_ACTIONS[number][] };
    if (input.phoneIds[0] !== '*' && !options.phones.some((phone) => phone.id === input.phoneIds[0])) {
      return json(res, 400, { error: 'phone scope is invalid' });
    }
    try { return json(res, 201, options.store.create(input)); }
    catch (err) { return json(res, 400, { error: err instanceof AppTokenInputError ? err.message : 'invalid token configuration' }); }
  }
  if (route.action === 'token' && req.method === 'DELETE') {
    if (!options.store.revoke(route.id)) return json(res, 404, { error: 'app token not found' });
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  return json(res, 405, { error: 'method not allowed' });
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
