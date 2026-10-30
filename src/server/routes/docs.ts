import { createRequire } from 'node:module';
import { createReadStream, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require = createRequire(import.meta.url);
const swaggerDir = path.dirname(require.resolve('swagger-ui-dist/package.json'));
const assets = new Map([
  ['swagger-ui.css', 'text/css; charset=utf-8'],
  ['swagger-ui-bundle.js', 'text/javascript; charset=utf-8'],
  ['swagger-ui-standalone-preset.js', 'text/javascript; charset=utf-8'],
]);

export function isDocsPath(pathname: string): boolean {
  return pathname === '/api/docs' || pathname === '/api/docs/' || pathname.startsWith('/api/docs/');
}

export function handleDocsRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, appToken = ''): boolean {
  if (!isDocsPath(pathname)) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  const name = pathname.replace(/^\/api\/docs\/?/, '');
  if (!name) {
    const auth = appToken ? `requestInterceptor: (request) => { request.headers.Authorization = ${JSON.stringify(`Bearer ${appToken}`)}; return request; },` : '';
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Timbre API</title><link rel="stylesheet" href="/api/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/api/docs/swagger-ui-bundle.js"></script><script src="/api/docs/swagger-ui-standalone-preset.js"></script><script>SwaggerUIBundle({url:"/v1/openapi.json",dom_id:"#swagger-ui",presets:[SwaggerUIBundle.presets.apis,SwaggerUIStandalonePreset],layout:"StandaloneLayout",persistAuthorization:true,${auth}});</script></body></html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : html);
    return true;
  }
  const contentType = assets.get(name);
  if (!contentType) return json(res, 404, { error: 'not found' });
  const file = path.join(swaggerDir, name);
  if (!existsSync(file)) return json(res, 404, { error: 'Swagger UI asset not found' });
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}

function json(res: http.ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
