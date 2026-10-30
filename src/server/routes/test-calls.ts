import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hub } from '../../hub.js';
import type { TestCallStreamEvent } from '../../phone/virtual-call-line.js';

export type TestCallRoute =
  | { action: 'start'; phoneId: string }
  | { action: 'events' | 'utterance' | 'end'; phoneId: string; callId: string };

export function matchTestCallRoute(pathname: string): TestCallRoute | null {
  const start = /^\/api\/phones\/([\w-]+)\/test-call$/.exec(pathname);
  if (start) return { action: 'start', phoneId: start[1] };
  const call = /^\/api\/phones\/([\w-]+)\/test-call\/([A-Za-z0-9_-]+)(?:\/(events|utterances))?$/.exec(pathname);
  if (!call) return null;
  const action = call[3] === 'events' ? 'events' : call[3] === 'utterances' ? 'utterance' : 'end';
  return { action, phoneId: call[1], callId: call[2] };
}

export async function handleTestCallRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: TestCallRoute,
  deps: { hub: Hub; readJson: (req: IncomingMessage) => Promise<unknown> },
): Promise<void> {
  if (route.action === 'start') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    let body: unknown;
    try { body = await deps.readJson(req); }
    catch { return json(res, 400, { error: 'invalid JSON body' }); }
    const callerNumber = (body as { callerNumber?: unknown })?.callerNumber;
    if (typeof callerNumber !== 'string' || callerNumber.trim().length < 3 || callerNumber.length > 32) {
      return json(res, 400, { error: 'callerNumber must be 3 to 32 characters' });
    }
    try { return json(res, 200, deps.hub.startTestCall(route.phoneId, callerNumber)); }
    catch (err) { return json(res, errorStatus(err), { error: (err as Error).message }); }
  }

  if (route.action === 'events') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    let unsubscribe: (() => void) | undefined;
    const queued: TestCallStreamEvent[] = [];
    let ready = false;
    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      res.off('close', finish);
      res.off('finish', finish);
      unsubscribe?.();
    };
    const sendEvent = (event: TestCallStreamEvent) => {
      if (closed) return;
      if (!ready) { queued.push(event); return; }
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'state' && event.state === 'ended') res.end();
    };
    try { unsubscribe = deps.hub.openTestCallStream(route.phoneId, route.callId, sendEvent); }
    catch (err) { return json(res, errorStatus(err), { error: (err as Error).message }); }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    ready = true;
    res.once('close', finish);
    res.once('finish', finish);
    heartbeat = setInterval(() => { if (!closed) res.write(': keepalive\n\n'); }, 20_000);
    heartbeat.unref?.();
    for (const event of queued) sendEvent(event);
    return;
  }

  if (route.action === 'utterance') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    let body: unknown;
    try { body = await deps.readJson(req); }
    catch { return json(res, 400, { error: 'invalid JSON body' }); }
    const text = (body as { text?: unknown })?.text;
    if (typeof text !== 'string' || text.trim().length < 1 || text.length > 4_000) {
      return json(res, 400, { error: 'text must be 1 to 4000 characters' });
    }
    try {
      deps.hub.submitTestCallUtterance(route.phoneId, route.callId, text);
      return json(res, 200, { ok: true });
    } catch (err) { return json(res, errorStatus(err), { error: (err as Error).message }); }
  }

  if (req.method !== 'DELETE') return json(res, 405, { error: 'method not allowed' });
  try {
    deps.hub.endTestCall(route.phoneId, route.callId);
    return json(res, 200, { ok: true });
  } catch (err) { return json(res, errorStatus(err), { error: (err as Error).message }); }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function errorStatus(err: unknown): number {
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  if (message.includes('not found')) return 404;
  if (message.includes('busy') || message.includes('one stream') || message.includes('one sse') || message.includes('unavailable') || message.includes('not connected')) return 409;
  return 400;
}
