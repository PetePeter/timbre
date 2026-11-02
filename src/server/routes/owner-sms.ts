import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSmsAction } from '../../actions/phone-actions.js';
import type { PhoneEntry } from '../../config/timbre-config.js';
import type { Hub } from '../../hub.js';

export interface OwnerSmsRoute { phoneId: string }

export function matchOwnerSmsRoute(pathname: string): OwnerSmsRoute | null {
  const match = /^\/api\/phones\/([\w-]{1,128})\/sms$/.exec(pathname);
  return match ? { phoneId: match[1] } : null;
}

export async function handleOwnerSmsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: OwnerSmsRoute,
  deps: { hub: Hub; phones: PhoneEntry[]; readJson: (req: IncomingMessage) => Promise<unknown> },
): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const phone = deps.phones.find((item) => item.id === route.phoneId);
  if (!phone) return json(res, 404, { error: 'phone not found' });
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    return json(res, 415, { error: 'application/json required' });
  }

  let body: unknown;
  try { body = await deps.readJson(req); }
  catch { return json(res, 400, { error: 'invalid JSON body' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(res, 400, { error: 'to and text are required' });
  }
  const input = body as Record<string, unknown>;
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  const text = typeof input.text === 'string' ? input.text : '';
  if (Object.keys(input).some((key) => key !== 'to' && key !== 'text')
    || to.length < 3 || to.length > 32 || !text.trim() || text.length > 2_000) {
    return json(res, 400, { error: 'SMS destination must be 3 to 32 characters and message must be 1 to 2000 characters' });
  }

  try {
    return json(res, 200, await sendSmsAction({ hub: deps.hub }, phone, to, text, 'Switchboard'));
  } catch {
    return json(res, 502, { error: 'SMS send failed' });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
