import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hub } from '../../hub.js';
import type { RecordEvent } from '../../records/event-types.js';
import type { LiveCallStreamRegistry } from './live-calls.js';

const HEARTBEAT_MS = 20_000;

export function matchActivityEventsRoute(pathname: string): boolean {
  return pathname === '/api/activity/events';
}

/** Owner-web SSE over the hub's existing per-phone record append subscription. */
export function handleActivityEventsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { hub: Hub; streams: LiveCallStreamRegistry },
): void {
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  if (isCrossOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });

  const visiblePhoneIds = new Set(deps.hub.status().map((phone) => phone.id));
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe = () => {};
  let unregister = () => {};
  const finish = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    res.off('close', finish);
    res.off('finish', finish);
    req.off('aborted', finish);
    unsubscribe();
    unregister();
    if (!res.writableEnded) res.end();
  };

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  unsubscribe = deps.hub.subscribeRecordEvents((phoneId, event) => {
    if (closed || !visiblePhoneIds.has(phoneId)) return;
    res.write(sse('record', { phoneId, event: activityEvent(event) }));
  });
  unregister = deps.streams.register(finish);
  res.write(sse('ready', { phoneIds: [...visiblePhoneIds] }));
  heartbeat = setInterval(() => { if (!closed) res.write(': keepalive\n\n'); }, HEARTBEAT_MS);
  res.once('close', finish);
  res.once('finish', finish);
  req.once('aborted', finish);
}

function activityEvent(event: RecordEvent): RecordEvent {
  const details = event.details;
  const safe: Record<string, unknown> = {};
  for (const key of ['contact', 'from', 'to', 'toolName'] as const) {
    if (typeof details[key] === 'string') safe[key] = (details[key] as string).slice(0, 120);
  }
  if (details.direction === 'inbound' || details.direction === 'outbound') safe.direction = details.direction;
  if (typeof details.durationSeconds === 'number' && Number.isFinite(details.durationSeconds)) safe.durationSeconds = Math.max(0, details.durationSeconds);
  if (details.outcome === 'completed' || details.outcome === 'failed') safe.outcome = details.outcome;
  return {
    eventId: event.eventId, interactionId: event.interactionId, kind: event.kind, type: event.type,
    occurredAt: event.occurredAt, details: safe, ...(event.test ? { test: true } : {}),
  };
}

function isCrossOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

function sse(type: string, value: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
