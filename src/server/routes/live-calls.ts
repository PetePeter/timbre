import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hub, LiveAudioEvent, LiveAudioFrame, LiveCallEvent } from '../../hub.js';

export type LiveCallRoute = { action: 'events' | 'audio' | 'takeover' | 'hangup'; phoneId: string };

export class LiveCallStreamRegistry {
  private readonly closeStreams = new Set<() => void>();

  register(close: () => void): () => void {
    this.closeStreams.add(close);
    return () => this.closeStreams.delete(close);
  }

  closeAll(): void {
    for (const close of [...this.closeStreams]) {
      try { close(); } catch { /* Close every stream even when one cleanup fails. */ }
    }
  }
}

export function matchLiveCallRoute(pathname: string): LiveCallRoute | null {
  const match = /^\/api\/phones\/([\w-]+)\/live-call\/(events|audio|takeover|hangup)$/.exec(pathname);
  return match ? { action: match[2] as LiveCallRoute['action'], phoneId: match[1] } : null;
}

export async function handleLiveCallRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: LiveCallRoute,
  deps: {
    hub: Hub;
    readJson: (req: IncomingMessage) => Promise<unknown>;
    streams: LiveCallStreamRegistry;
  },
): Promise<void> {
  if (route.action === 'events') return handleEvents(req, res, route, deps);
  if (route.action === 'audio') return handleAudio(req, res, route, deps);
  if (route.action === 'hangup') return handleHangup(req, res, route, deps);
  return handleTakeover(req, res, route, deps);
}

async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  route: LiveCallRoute,
  deps: { hub: Hub; streams: LiveCallStreamRegistry },
): Promise<void> {
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  const callId = callIdFromUrl(req);
  if (!callId) return json(res, 400, { error: 'callId is required' });

  let stream: ReturnType<Hub['openLiveCallStream']> | undefined;
  let ready = false;
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  const queued: LiveCallEvent[] = [];
  let unregister = () => {};
  const finish = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    res.off('close', finish);
    res.off('finish', finish);
    unregister();
    stream?.close();
  };
  const sendEvent = (event: LiveCallEvent) => {
    if (closed) return;
    if (!ready) { queued.push(event); return; }
    writeSse(res, event.type, event);
    if (event.type === 'state' && event.state === 'ended') res.end();
  };

  res.once('close', finish);
  res.once('finish', finish);
  unregister = deps.streams.register(() => { finish(); if (!res.writableEnded) res.end(); });
  try { stream = deps.hub.openLiveCallStream(route.phoneId, callId, sendEvent); }
  catch (err) {
    finish();
    return json(res, errorStatus(err), { error: errorMessage(err) });
  }
  if (closed || res.destroyed) { finish(); return; }

  openSse(res);
  ready = true;
  heartbeat = setInterval(() => { if (!closed) res.write(': keepalive\n\n'); }, 20_000);
  heartbeat.unref?.();
  writeSse(res, 'snapshot', stream.snapshot);
  for (const event of queued) sendEvent(event);
}

async function handleAudio(
  req: IncomingMessage,
  res: ServerResponse,
  route: LiveCallRoute,
  deps: { hub: Hub; streams: LiveCallStreamRegistry },
): Promise<void> {
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  const callId = callIdFromUrl(req);
  if (!callId) return json(res, 400, { error: 'callId is required' });

  let closeAudio: (() => void) | undefined;
  let ready = false;
  let blocked = false;
  let closed = false;
  let ended = false;
  let heartbeat: NodeJS.Timeout | undefined;
  const queued: LiveAudioFrame[] = [];
  let unregister = () => {};
  const finish = () => {
    if (closed) return;
    closed = true;
    queued.length = 0;
    if (heartbeat) clearInterval(heartbeat);
    res.off('close', finish);
    res.off('finish', finish);
    res.off('drain', flush);
    unregister();
    closeAudio?.();
  };
  const writeFrame = (frame: LiveAudioFrame) => {
    if (closed || !isFrameForCall(frame, callId)) return;
    blocked = !res.write(formatSse('frame', frame));
  };
  const flush = () => {
    blocked = false;
    while (!closed && !blocked && queued.length) writeFrame(queued.shift()!);
  };
  const queueFrame = (frame: LiveAudioFrame) => {
    if (!isFrameForCall(frame, callId)) return;
    if (queued.length === MAX_QUEUED_AUDIO_FRAMES) queued.shift();
    queued.push(frame);
  };
  const onAudio = (event: LiveAudioEvent) => {
    if (closed) return;
    if (event.type === 'ended') {
      ended = true;
      queued.length = 0;
      if (ready) { writeSse(res, 'ended', { callId }); res.end(); }
      return;
    }
    if (!ready || blocked) queueFrame(event.frame);
    else writeFrame(event.frame);
  };

  res.once('close', finish);
  res.once('finish', finish);
  res.on('drain', flush);
  unregister = deps.streams.register(() => { finish(); if (!res.writableEnded) res.end(); });
  try { closeAudio = await deps.hub.openLiveAudioStream(route.phoneId, callId, onAudio); }
  catch (err) {
    finish();
    return json(res, errorStatus(err), { error: errorMessage(err) });
  }
  if (closed || res.destroyed) { closeAudio(); finish(); return; }

  openSse(res);
  ready = true;
  heartbeat = setInterval(() => {
    if (!closed) blocked = !res.write(': keepalive\n\n') || blocked;
  }, 20_000);
  heartbeat.unref?.();
  if (ended) { writeSse(res, 'ended', { callId }); res.end(); }
  else flush();
}

async function handleTakeover(
  req: IncomingMessage,
  res: ServerResponse,
  route: LiveCallRoute,
  deps: { hub: Hub; readJson: (req: IncomingMessage) => Promise<unknown> },
): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    return json(res, 415, { error: 'application/json required' });
  }
  let body: unknown;
  try { body = await deps.readJson(req); }
  catch { return json(res, 400, { error: 'invalid JSON body' }); }
  const callId = (body as { callId?: unknown })?.callId;
  if (typeof callId !== 'string' || !isCallId(callId)) return json(res, 400, { error: 'valid callId is required' });
  try {
    await deps.hub.takeoverLiveCall(route.phoneId, callId);
    return json(res, 200, { ok: true });
  } catch (err) { return json(res, errorStatus(err), { error: errorMessage(err) }); }
}

async function handleHangup(
  req: IncomingMessage,
  res: ServerResponse,
  route: LiveCallRoute,
  deps: { hub: Hub; readJson: (req: IncomingMessage) => Promise<unknown> },
): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    return json(res, 415, { error: 'application/json required' });
  }
  let body: unknown;
  try { body = await deps.readJson(req); }
  catch { return json(res, 400, { error: 'invalid JSON body' }); }
  const callId = (body as { callId?: unknown })?.callId;
  if (typeof callId !== 'string' || !isCallId(callId)) return json(res, 400, { error: 'valid callId is required' });
  const line = deps.hub.line(route.phoneId);
  if (!line) return json(res, 404, { error: 'phone line not found' });
  if (!line.hangupCurrentCall) return json(res, 503, { error: 'phone line does not support owner hangup' });
  try {
    if (!await line.hangupCurrentCall(callId)) return json(res, 404, { error: 'live call not found' });
    return json(res, 200, { hungUp: true });
  } catch (err) { return json(res, errorStatus(err), { error: errorMessage(err) }); }
}

const MAX_QUEUED_AUDIO_FRAMES = 10;

function isFrameForCall(frame: LiveAudioFrame, callId: string): boolean {
  return !!frame && frame.callId === callId && Number.isInteger(frame.sequence) && frame.sequence >= 0
    && frame.sampleRate === 8000 && frame.channels === 2 && frame.encoding === 'pcm_s16le'
    && typeof frame.data === 'string' && frame.data.length === 856 && /^[A-Za-z0-9+/]{854}==$/.test(frame.data);
}

function callIdFromUrl(req: IncomingMessage): string {
  const value = new URL(req.url ?? '/', 'http://localhost').searchParams.get('callId') ?? '';
  return isCallId(value) ? value : '';
}

function isCallId(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }

function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
}

function writeSse(res: ServerResponse, type: string, data: unknown): void {
  res.write(formatSse(type, data));
}

function formatSse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function errorMessage(err: unknown): string { return err instanceof Error ? err.message : String(err); }

function errorStatus(err: unknown): number {
  const message = errorMessage(err).toLowerCase();
  if (message.includes('not found')) return 404;
  if (message.includes('unavailable') || message.includes('not connected') || message.includes('not active')
    || message.includes('busy') || message.includes('already')) return 409;
  return 400;
}
