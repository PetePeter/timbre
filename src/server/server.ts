/**
 * One HTTP server for every UI (desktop browser, other PCs, phones) plus the
 * MCP endpoint CLI agents call. Localhost is trusted; anything else needs
 * LAN access switched on AND the token. Writes from another origin are refused.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { addPhone, dataDir, redactMcpSecrets, removePhone, restoreMaskedMcpSecrets, type ConfigStore, type TimbreConfig, type WebConfig } from '../config/timbre-config.js';
import type { Hub } from '../hub.js';
import { CliAgent } from '../agents/cli-agent.js';
import { handleMcp } from './mcp.js';
import { handleContactsRoute, matchContactsRoute } from './routes/contacts.js';
import { handleRecordsRoute, matchRecordsRoute } from './routes/records.js';
import { handlePhoneSetupRoute, matchPhoneSetupRoute } from './routes/phone-setup.js';

export interface ServerOptions {
  hub: Hub;
  store: ConfigStore;
  /** Built web UI (Vite output). */
  staticDir: string;
  log: (msg: string) => void;
  /** Rebinds the listener when its port or LAN setting changes. */
  onWebConfigChange?: () => Promise<void>;
}

const MAX_BODY = 1_000_000;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

export function isLoopback(addr: string): boolean {
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(headers: IncomingHttpHeaders, name: string): string {
  for (const part of (headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function bearer(headers: IncomingHttpHeaders): string {
  return /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1] ?? '';
}

export function authorize(remote: string, headers: IncomingHttpHeaders, web: WebConfig): boolean {
  if (isLoopback(remote)) return true;
  if (!web.lan || !web.token) return false;
  const given = bearer(headers) || cookie(headers, 'timbre_token');
  return !!given && sameSecret(given, web.token);
}

/** A browser write from a page on another origin (CSRF) — never allowed. */
function crossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createServer(opts: ServerOptions): http.Server {
  const { hub, store } = opts;

  async function saveAndApply(res: ServerResponse, next: TimbreConfig): Promise<void> {
    const dongles = new Map<string, string>();
    for (const phone of next.phones) {
      const match = /^usb:([0-9a-f]{4}):([0-9a-f]{4})(?:\+sco=\d+)?$/i.exec(phone.line.transport.trim());
      if (!match) continue;
      const id = `${match[1].toUpperCase()}:${match[2].toUpperCase()}`;
      const existing = dongles.get(id);
      if (existing) return send(res, 409, { error: `Bluetooth dongle ${id} is already assigned to ${existing}` });
      dongles.set(id, phone.name || phone.id);
    }
    const previousWeb = store.get().web;
    const saved = store.save(restoreMaskedMcpSecrets(store.get(), next));
    const bindChanged = previousWeb.port !== saved.web.port || previousWeb.lan !== saved.web.lan;
    let bindFailure: string | undefined;
    if (bindChanged && opts.onWebConfigChange) {
      try {
        await opts.onWebConfigChange();
      } catch (err) {
        const current = store.get();
        store.save({
          ...current,
          web: { ...current.web, port: previousWeb.port, lan: previousWeb.lan },
        });
        bindFailure = `web listener rebind failed: ${(err as Error).message}`;
        opts.log(bindFailure);
      }
    }
    await hub.apply();
    if (bindFailure) return send(res, 500, { error: bindFailure });
    send(res, 200, redactMcpSecrets(saved));
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const phoneSetupRoute = matchPhoneSetupRoute(p);
    if (phoneSetupRoute) {
      await handlePhoneSetupRoute(req, res, phoneSetupRoute, { phones: store.get().phones, dataDir: dataDir(), readJson });
      return;
    }
    if (matchContactsRoute(p)) {
      await handleContactsRoute(req, res, url, { phones: store.get().phones, log: opts.log, readJson });
      return;
    }
    if (handleRecordsRoute(req, res, url, hub)) return;
    if (req.method === 'GET' && p === '/api/status') return send(res, 200, { phones: hub.status() });
    if (req.method === 'GET' && p === '/api/config') return send(res, 200, redactMcpSecrets(store.get()));
    if (req.method === 'PUT' && p === '/api/config') return saveAndApply(res, await readJson(req) as TimbreConfig);
    if (req.method === 'POST' && p === '/api/phones') {
      const { name } = await readJson(req) as { name?: string };
      return saveAndApply(res, addPhone(store.get(), name?.trim() || 'New phone'));
    }
    const del = /^\/api\/phones\/([\w-]+)$/.exec(p);
    if (req.method === 'DELETE' && del) {
      let next: TimbreConfig;
      try { next = removePhone(store.get(), del[1]); } catch (err) { return send(res, 400, { error: (err as Error).message }); }
      return saveAndApply(res, next);
    }
    const m = /^\/api\/phones\/([\w-]+)\/(restart|test-sms|terminal)$/.exec(p);
    const line = m && hub.line(m[1]);
    if (m && line) {
      if (req.method === 'POST' && m[2] === 'restart') { await line.restart(); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && m[2] === 'test-sms') return send(res, 200, await line.testSms());
      if (req.method === 'GET' && m[2] === 'terminal') {
        const agent = hub.agent(m[1]);
        return send(res, 200, { text: agent instanceof CliAgent ? agent.getTail() : '' });
      }
    }
    send(res, 404, { error: 'not found' });
  }

  function serveStatic(res: ServerResponse, pathname: string): void {
    const root = path.resolve(opts.staticDir);
    let file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(root)) return send(res, 400, { error: 'bad path' });
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!existsSync(file)) return send(res, 404, { error: 'web UI not built (npm run build)' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  }

  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/mcp/')) {
        const phoneId = url.pathname.slice(5);
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        if (hub.phoneForToken(bearer(req.headers)) !== phoneId) return send(res, 401, { error: 'bad token' });
        const reply = await handleMcp(await readJson(req), hub.line(phoneId)!, phoneId);
        if (!reply) { res.writeHead(202).end(); return; }
        return send(res, 200, reply);
      }
      const contactsRoute = matchContactsRoute(url.pathname);
      const tokenPhoneId = contactsRoute && hub.phoneForToken(bearer(req.headers));
      if (contactsRoute && tokenPhoneId) {
        if (tokenPhoneId !== contactsRoute.phoneId) return send(res, 401, { error: 'bad token' });
        if (req.method !== 'GET' && crossOrigin(req)) return send(res, 403, { error: 'cross-origin write refused' });
        await handleContactsRoute(req, res, url, { phones: store.get().phones, log: opts.log, readJson });
        return;
      }
      const recordsRoute = matchRecordsRoute(url.pathname);
      const recordsPhoneId = recordsRoute && hub.phoneForToken(bearer(req.headers));
      if (recordsRoute && recordsPhoneId) {
        if (recordsPhoneId !== recordsRoute.phoneId) return send(res, 401, { error: 'bad token' });
        if (req.method !== 'GET' && crossOrigin(req)) return send(res, 403, { error: 'cross-origin write refused' });
        handleRecordsRoute(req, res, url, hub);
        return;
      }
      const web = store.get().web;
      // ?token= on a LAN link sets the cookie once, then the URL drops it.
      const linkToken = url.searchParams.get('token');
      if (linkToken && web.lan && web.token && sameSecret(linkToken, web.token)) {
        res.writeHead(302, { 'set-cookie': `timbre_token=${web.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, location: url.pathname });
        res.end();
        return;
      }
      if (!authorize(req.socket.remoteAddress ?? '', req.headers, web)) return send(res, 401, { error: 'token required' });
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && crossOrigin(req)) return send(res, 403, { error: 'cross-origin write refused' });
        return api(req, res, url);
      }
      serveStatic(res, url.pathname);
    })().catch((err) => {
      opts.log(`http ${req.method} ${req.url}: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
      else res.end();
    });
  });
}
