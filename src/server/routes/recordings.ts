import { createReadStream, lstatSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hub } from '../../hub.js';

export interface RecordingsRoute { phoneId: string; interactionId: string; audio: boolean }

export function matchRecordingsRoute(pathname: string): RecordingsRoute | null {
  const match = /^\/api\/phones\/([\w-]+)\/recordings\/([A-Za-z0-9_-]{1,128})(\/audio)?$/.exec(pathname);
  if (!match) return null;
  return { phoneId: match[1], interactionId: match[2], audio: match[3] !== undefined };
}

export function handleRecordingsRoute(req: IncomingMessage, res: ServerResponse, route: RecordingsRoute, hub: Hub): boolean {
  if (req.method !== 'GET' && !(route.audio && req.method === 'HEAD')) return json(res, 405, { error: 'method not allowed' });
  const record = hub.getRecord(route.phoneId, route.interactionId);
  if (!record || record.kind !== 'call') return json(res, 404, { error: 'call not found' });

  const artifacts = hub.getCallArtifacts(route.phoneId, route.interactionId);
  if (!artifacts) return json(res, 404, { error: 'phone not found' });
  if (!route.audio) return json(res, 200, artifacts);
  if (!artifacts.audioAvailable) return json(res, 404, { error: 'recording not found' });

  const file = hub.callRecordingPath(route.phoneId, route.interactionId);
  if (!file) return json(res, 404, { error: 'recording not found' });
  try {
    if (!lstatSync(file).isFile()) return json(res, 404, { error: 'recording not found' });
    const size = statSync(file).size;
    const range = req.headers.range === undefined ? undefined : parseRange(req.headers.range, size);
    if (req.headers.range !== undefined && !range) {
      res.writeHead(416, { 'accept-ranges': 'bytes', 'content-range': `bytes */${size}`, 'cache-control': 'no-store' });
      res.end();
      return true;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, size - 1);
    const headers = {
      'content-type': 'audio/wav',
      'content-length': String(size === 0 ? 0 : end - start + 1),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    };
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || size === 0) { res.end(); return true; }
    const stream = createReadStream(file, range ? { start, end } : undefined);
    stream.on('error', () => { if (!res.headersSent) json(res, 404, { error: 'recording not found' }); else res.destroy(); });
    stream.pipe(res);
    return true;
  } catch { return json(res, 404, { error: 'recording not found' }); }
}

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end };
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
