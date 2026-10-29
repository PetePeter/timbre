import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hub } from '../../hub.js';
import type { RecordQueryOptions } from '../../records/event-types.js';

export interface RecordsRoute { phoneId: string; interactionId?: string }

export function matchRecordsRoute(pathname: string): RecordsRoute | null {
  const match = /^\/api\/phones\/([\w-]+)\/records(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  return { phoneId: match[1], ...(match[2] === undefined ? {} : { interactionId: match[2] }) };
}

export function handleRecordsRoute(req: IncomingMessage, res: ServerResponse, url: URL, hub: Hub): boolean {
  const route = matchRecordsRoute(url.pathname);
  if (!route) return false;
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  if (!hub.status().some((phone) => phone.id === route.phoneId)) return json(res, 404, { error: 'phone not found' });
  try {
    if (route.interactionId !== undefined) {
      const interactionId = decodeURIComponent(route.interactionId);
      const record = hub.getRecord(route.phoneId, interactionId);
      return record ? json(res, 200, record) : json(res, 404, { error: 'record not found' });
    }
    const options = readOptions(url.searchParams);
    const page = hub.listRecords(route.phoneId, options);
    return page ? json(res, 200, page) : json(res, 404, { error: 'phone not found' });
  } catch (err) {
    return json(res, 400, { error: (err as Error).message });
  }
}

function readOptions(params: URLSearchParams): RecordQueryOptions {
  const filter = params.get('filter') ?? undefined;
  if (filter && !['all', 'calls', 'sms', 'conferences', 'blocked'].includes(filter)) throw new Error('invalid record filter');
  const limit = params.get('limit');
  return {
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    cursor: params.get('cursor') ?? undefined,
    limit: limit === null ? undefined : Number(limit),
    filter: filter as RecordQueryOptions['filter'],
  };
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
