import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RecordSearchIndex } from '../../records/record-search-index.js';

export interface SearchRoute { phoneId: string }
export interface SearchRouteDependencies {
  phoneIds: () => string[];
  index: RecordSearchIndex;
}

export function matchSearchRoute(pathname: string): SearchRoute | null {
  const match = /^\/api\/phones\/([\w-]+)\/search$/.exec(pathname);
  return match ? { phoneId: match[1] } : null;
}

export function handleSearchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: SearchRouteDependencies,
): boolean {
  const route = matchSearchRoute(url.pathname);
  if (!route) return false;
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  if (!deps.phoneIds().includes(route.phoneId)) return json(res, 404, { error: 'phone not found' });
  const query = url.searchParams.get('q') ?? '';
  if (query.length > 512) return json(res, 400, { error: 'query is too long' });
  return json(res, 200, deps.index.search(route.phoneId, query));
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
