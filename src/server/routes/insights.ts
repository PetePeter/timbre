import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hub } from '../../hub.js';
import { aggregateCallAnalytics } from '../../records/analytics.js';

export interface InsightsRoute { phoneId: string }

export function matchInsightsRoute(pathname: string): InsightsRoute | null {
  const match = /^\/api\/phones\/([\w-]+)\/insights$/.exec(pathname);
  return match ? { phoneId: match[1] } : null;
}

export function handleInsightsRoute(req: IncomingMessage, res: ServerResponse, url: URL, hub: Hub): boolean {
  const route = matchInsightsRoute(url.pathname);
  if (!route) return false;
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  const events = hub.readRecordEvents(route.phoneId);
  if (!events) return json(res, 404, { error: 'phone not found' });
  try {
    const from = url.searchParams.get('from') ?? undefined;
    const to = url.searchParams.get('to') ?? undefined;
    if (!from || !to) throw new Error('from and to are required');
    return json(res, 200, aggregateCallAnalytics(events, { from, to }));
  } catch (err) {
    return json(res, 400, { error: (err as Error).message });
  }
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
