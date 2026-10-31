/**
 * One HTTP server for the UI, phone-agent MCP, and app-token MCP. Localhost is
 * trusted for owner routes; LAN access needs its token. Writes from another origin are refused.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { addPhone, dataDir, redactMcpSecrets, removePhone, restoreMaskedMcpSecrets, type ConfigStore, type TimbreConfig, type WebConfig } from '../config/timbre-config.js';
import type { Hub } from '../hub.js';
import { createCallAction, InvalidCallRequestError } from '../actions/phone-actions.js';
import { AppTokenStore } from '../config/app-token-store.js';
import { AppMcpRateLimiter, handleAppMcpHttp } from './app-mcp.js';
import { CliAgent } from '../agents/cli-agent.js';
import { handleMcp } from './mcp.js';
import { handleContactsRoute, matchContactsRoute } from './routes/contacts.js';
import { handleRecordsRoute, matchRecordsRoute } from './routes/records.js';
import { handleRecordingsRoute, matchRecordingsRoute } from './routes/recordings.js';
import { handlePhoneSetupRoute, matchPhoneSetupRoute } from './routes/phone-setup.js';
import { handleSearchRoute, matchSearchRoute } from './routes/search.js';
import { handleInsightsRoute, matchInsightsRoute } from './routes/insights.js';
import { handleServerFileListRoute, isServerFileListRoute } from './routes/filesystem.js';
import { createBackupRoutes, matchBackupRoute } from './routes/backup.js';
import { RecordSearchIndex } from '../records/record-search-index.js';
import { VoiceCatalogue } from '../voice/voice-catalogue.js';
import { synthesizePiperPreview } from '../voice/piper-preview.js';
import { listSapiVoices, synthesizeSapiPreview } from '../voice/sapi-preview.js';
import { VoicePreviewService } from '../voice/voice-preview.js';
import { handleVoiceRoute, matchVoiceRoute, type VoiceRouteOptions } from './routes/voices.js';
import { handleAppTokenRoute, matchAppTokenRoute } from './routes/app-tokens.js';
import { handleDocsRoute, isDocsPath } from './routes/docs.js';
import { openApiDocument } from './routes/v1/contract.js';
import { handleV1Request } from './routes/v1/handler.js';
import { handleTestCallRoute, matchTestCallRoute } from './routes/test-calls.js';
import { handleLiveCallRoute, LiveCallStreamRegistry, matchLiveCallRoute } from './routes/live-calls.js';
import { handleActivityEventsRoute, matchActivityEventsRoute } from './routes/activity-events.js';
import { WEB_SERVER_PRE_CLOSE } from './web-server-runtime.js';

export interface ServerOptions {
  hub: Hub;
  store: ConfigStore;
  /** Built web UI (Vite output). */
  staticDir: string;
  log: (msg: string) => void;
  /** Per-user data root; defaults to the standard Timbre directory. */
  dataDir?: string;
  /** Application repository root, used to keep server backup files outside the app. */
  repositoryRoot?: string;
  /** Rebinds the listener when its port or LAN setting changes. */
  onWebConfigChange?: () => Promise<void>;
  /** Optional test seam; production builds these around dataDir and the configured phone executables. */
  voiceRoutes?: Pick<VoiceRouteOptions, 'catalogue' | 'preview'>;
}

const MAX_BODY = 1_000_000;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const PUBLIC_PWA_ASSETS = new Set([
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/pwa-icon-512-maskable.png',
]);

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

function isBackupRestoreRoute(route: ReturnType<typeof matchBackupRoute>): boolean {
  return route?.action === 'import' || route?.action === 'import-server-file';
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
  const dataRoot = opts.dataDir ?? dataDir();
  const appTokens = new AppTokenStore(path.join(dataRoot, 'app-tokens.json'));
  const appMcpRateLimiter = new AppMcpRateLimiter();
  const liveCallStreams = new LiveCallStreamRegistry();
  let activeRequests = 0;
  const requestDrainWaiters = new Set<() => void>();
  const waitForActiveRequests = () => activeRequests === 0 ? Promise.resolve() : new Promise<void>((resolve) => requestDrainWaiters.add(resolve));
  const trackRequest = (res: ServerResponse) => {
    activeRequests++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      res.off('finish', release);
      res.off('close', release);
      activeRequests--;
      if (activeRequests === 0) {
        for (const resolve of requestDrainWaiters) resolve();
        requestDrainWaiters.clear();
      }
    };
    res.once('finish', release);
    res.once('close', release);
  };
  let searchIndex = new RecordSearchIndex(dataRoot, opts.log);
  const voiceCatalogue = opts.voiceRoutes?.catalogue ?? new VoiceCatalogue(
    path.join(dataRoot, 'voices'),
    () => store.get().customPiperModels,
    listSapiVoices,
  );
  const voicePreview = opts.voiceRoutes?.preview ?? new VoicePreviewService(voiceCatalogue, {
    piper: (model, text) => synthesizePiperPreview(model, text, store.get().telefony.executable),
    sapi: synthesizeSapiPreview,
  });
  for (const phone of store.get().phones) void searchIndex.warmPhone(phone.id);
  let searchDeps = { phoneIds: () => store.get().phones.map((phone) => phone.id), index: searchIndex };
  const backupRoutes = createBackupRoutes({
    dataDir: dataRoot, repositoryRoot: opts.repositoryRoot, store, hub, log: opts.log, readJson,
    beforeRestore: async () => {
      liveCallStreams.closeAll();
      await waitForActiveRequests();
      await Promise.all(store.get().phones.map((phone) => searchIndex.warmPhone(phone.id)));
      searchIndex.dispose();
    },
    onWebConfigChange: opts.onWebConfigChange,
    onRestore: () => {
      searchIndex.dispose();
      searchIndex = new RecordSearchIndex(dataRoot, opts.log);
      searchDeps = { phoneIds: () => store.get().phones.map((phone) => phone.id), index: searchIndex };
      for (const phone of store.get().phones) void searchIndex.warmPhone(phone.id);
    },
  });

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
    if (bindChanged || previousWeb.token !== saved.web.token) liveCallStreams.closeAll();
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
    if (matchActivityEventsRoute(p)) {
      handleActivityEventsRoute(req, res, { hub, streams: liveCallStreams });
      return;
    }
    const phoneMcpConnection = /^\/api\/phones\/([\w-]+)\/mcp-connection$/.exec(p);
    if (phoneMcpConnection) {
      if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
      const phoneId = phoneMcpConnection[1];
      if (!store.get().phones.some((phone) => phone.id === phoneId)) return send(res, 404, { error: 'phone not found' });
      const token = hub.phoneMcpToken(phoneId);
      if (!token) return send(res, 503, { error: 'phone MCP endpoint is not ready' });
      return send(res, 200, { token });
    }
    const ownerCall = /^\/api\/phones\/([\w-]+)\/calls$/.exec(p);
    if (ownerCall) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const phone = store.get().phones.find((item) => item.id === ownerCall[1]);
      if (!phone) return send(res, 404, { error: 'phone not found' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'application/json required' });
      let body: unknown;
      try { body = await readJson(req); } catch { return send(res, 400, { error: 'invalid JSON body' }); }
      try {
        const context = { hub, dataDir: dataRoot, log: opts.log, searchIndex };
        return send(res, 202, await createCallAction(context, phone, body, 'Switchboard'));
      } catch (err) {
        return send(res, err instanceof InvalidCallRequestError ? 400 : 409, { error: (err as Error).message || 'call could not be started' });
      }
    }
    const testCallRoute = matchTestCallRoute(p);
    if (testCallRoute) {
      await handleTestCallRoute(req, res, testCallRoute, { hub, readJson });
      return;
    }
    const appTokenRoute = matchAppTokenRoute(p);
    if (appTokenRoute) {
      await handleAppTokenRoute(req, res, appTokenRoute, { store: appTokens, phones: store.get().phones, readJson });
      return;
    }
    const backupRoute = matchBackupRoute(p);
    if (backupRoute) {
      await backupRoutes.handle(req, res, backupRoute);
      return;
    }
    const voiceRoute = matchVoiceRoute(p);
    if (voiceRoute) {
      await handleVoiceRoute(req, res, voiceRoute, { store, catalogue: voiceCatalogue, preview: voicePreview, readJson });
      return;
    }
    const phoneSetupRoute = matchPhoneSetupRoute(p);
    if (phoneSetupRoute) {
      await handlePhoneSetupRoute(req, res, phoneSetupRoute, { phones: store.get().phones, telefonyExecutable: store.get().telefony.executable, dataDir: dataDir(), readJson });
      return;
    }
    if (matchContactsRoute(p)) {
      await handleContactsRoute(req, res, url, { phones: store.get().phones, log: opts.log, readJson });
      return;
    }
    if (handleSearchRoute(req, res, url, searchDeps)) return;
    const recordingsRoute = matchRecordingsRoute(p);
    if (recordingsRoute) {
      handleRecordingsRoute(req, res, recordingsRoute, hub);
      return;
    }
    if (handleRecordsRoute(req, res, url, hub)) return;
    if (handleInsightsRoute(req, res, url, hub)) return;
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

  function serveStatic(res: ServerResponse, pathname: string, fallbackToIndex = true): void {
    const root = path.resolve(opts.staticDir);
    let file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(root)) return send(res, 400, { error: 'bad path' });
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (!fallbackToIndex) return send(res, 404, { error: 'not found' });
      file = path.join(root, 'index.html');
    }
    if (!existsSync(file)) return send(res, 404, { error: 'web UI not built (npm run build)' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const backupRoute = matchBackupRoute(url.pathname);
      if (backupRoute && hub.phoneForToken(bearer(req.headers))) {
        return send(res, 401, { error: 'owner authorization required' });
      }
      if (backupRoutes.isRestoring() && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp/') || url.pathname === '/mcp' || url.pathname.startsWith('/v1/'))
        && !isBackupRestoreRoute(backupRoute)) {
        req.resume();
        return send(res, 409, { error: 'backup restore is in progress' });
      }
      if (url.pathname.startsWith('/mcp/')) {
        const phoneId = url.pathname.slice(5);
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        if (hub.phoneForToken(bearer(req.headers)) !== phoneId) return send(res, 401, { error: 'bad token' });
        trackRequest(res);
        const reply = await handleMcp(await readJson(req), hub.line(phoneId)!, phoneId);
        if (!reply) { res.writeHead(202).end(); return; }
        return send(res, 200, reply);
      }
      const rawAppToken = bearer(req.headers);
      const appAccess = appTokens.authenticate(rawAppToken);
      const web = store.get().web;
      const operatorSettingsRoute = url.pathname === '/api/config'
        || matchPhoneSetupRoute(url.pathname)?.action === 'descriptor';
      if (operatorSettingsRoute && (appAccess || hub.phoneForToken(rawAppToken))) {
        req.resume();
        return send(res, 401, { error: 'web authorization required' });
      }
      if (url.pathname === '/mcp') {
        if (!appAccess) { req.resume(); return send(res, 401, { error: 'app token required' }); }
        return handleAppMcpHttp(req, res, {
          hub, phones: store.get().phones, dataDir: dataRoot, log: opts.log, searchIndex,
          access: appAccess, rateLimiter: appMcpRateLimiter, readJson, crossOrigin, trackRequest, send,
        });
      }
      if (url.pathname === '/v1/openapi.json') {
        if (!appAccess && !authorize(req.socket.remoteAddress ?? '', req.headers, web)) return send(res, 401, { error: 'token required' });
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
        trackRequest(res);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(openApiDocument()));
      }
      if (url.pathname.startsWith('/v1/')) {
        if (!appAccess) { req.resume(); return send(res, 401, { error: 'app token required' }); }
        if (req.method !== 'GET' && req.method !== 'HEAD' && crossOrigin(req)) return send(res, 403, { error: 'cross-origin write refused' });
        trackRequest(res);
        await handleV1Request(req, res, url, {
          hub, phones: store.get().phones, dataDir: dataRoot, log: opts.log, searchIndex, readJson, streams: liveCallStreams,
        }, appAccess);
        return;
      }
      if (isDocsPath(url.pathname)) {
        if (!appAccess && !authorize(req.socket.remoteAddress ?? '', req.headers, web)) return send(res, 401, { error: 'token required' });
        handleDocsRoute(req, res, url.pathname, appAccess ? rawAppToken : '');
        return;
      }
      const liveCallRoute = matchLiveCallRoute(url.pathname);
      if (liveCallRoute) {
        if (appAccess || hub.phoneForToken(rawAppToken)) {
          req.resume();
          return send(res, 401, { error: 'web authorization required' });
        }
        if (!authorize(req.socket.remoteAddress ?? '', req.headers, web)) {
          req.resume();
          return send(res, 401, { error: 'token required' });
        }
        const liveCallStream = liveCallRoute.action === 'events' || liveCallRoute.action === 'audio';
        const crossSiteStream = liveCallStream && req.headers['sec-fetch-site'] === 'cross-site';
        const crossOriginAction = crossOrigin(req) && (req.method !== 'GET' || liveCallRoute.action === 'audio');
        if (crossOriginAction || crossSiteStream) {
          req.resume();
          return send(res, 403, { error: 'cross-origin request refused' });
        }
        if (liveCallRoute.action === 'takeover' || liveCallRoute.action === 'hangup') trackRequest(res);
        await handleLiveCallRoute(req, res, liveCallRoute, { hub, readJson, streams: liveCallStreams });
        return;
      }
      const contactsRoute = matchContactsRoute(url.pathname);
      const tokenPhoneId = contactsRoute && hub.phoneForToken(bearer(req.headers));
      if (contactsRoute && tokenPhoneId) {
        if (tokenPhoneId !== contactsRoute.phoneId) return send(res, 401, { error: 'bad token' });
        if (req.method !== 'GET' && crossOrigin(req)) return send(res, 403, { error: 'cross-origin write refused' });
        trackRequest(res);
        await handleContactsRoute(req, res, url, { phones: store.get().phones, log: opts.log, readJson });
        return;
      }
      const searchRoute = matchSearchRoute(url.pathname);
      const searchPhoneId = searchRoute && hub.phoneForToken(bearer(req.headers));
      if (searchRoute && searchPhoneId) {
        if (searchPhoneId !== searchRoute.phoneId) return send(res, 401, { error: 'bad token' });
        trackRequest(res);
        handleSearchRoute(req, res, url, searchDeps);
        return;
      }
      const recordsRoute = matchRecordsRoute(url.pathname);
      const recordsPhoneId = recordsRoute && hub.phoneForToken(bearer(req.headers));
      if (recordsRoute && recordsPhoneId) {
        if (recordsPhoneId !== recordsRoute.phoneId) return send(res, 401, { error: 'bad token' });
        if (req.method !== 'GET' && crossOrigin(req)) return send(res, 403, { error: 'cross-origin write refused' });
        trackRequest(res);
        handleRecordsRoute(req, res, url, hub);
        return;
      }
      const insightsRoute = matchInsightsRoute(url.pathname);
      const insightsPhoneId = insightsRoute && hub.phoneForToken(bearer(req.headers));
      if (insightsRoute && insightsPhoneId) {
        if (insightsPhoneId !== insightsRoute.phoneId) return send(res, 401, { error: 'bad token' });
        if (req.method !== 'GET' && crossOrigin(req)) return send(res, 403, { error: 'cross-origin write refused' });
        trackRequest(res);
        handleInsightsRoute(req, res, url, hub);
        return;
      }
      const recordingsRoute = matchRecordingsRoute(url.pathname);
      const recordingsPhoneId = recordingsRoute && hub.phoneForToken(bearer(req.headers));
      if (recordingsRoute && recordingsPhoneId) {
        if (recordingsPhoneId !== recordingsRoute.phoneId) return send(res, 401, { error: 'bad token' });
        if (req.method !== 'GET' && req.method !== 'HEAD' && crossOrigin(req)) return send(res, 403, { error: 'cross-origin write refused' });
        trackRequest(res);
        handleRecordingsRoute(req, res, recordingsRoute, hub);
        return;
      }
      if (isServerFileListRoute(url.pathname)) {
        if (appAccess || hub.phoneForToken(rawAppToken)) {
          req.resume();
          return send(res, 401, { error: 'web authorization required' });
        }
        if (!authorize(req.socket.remoteAddress ?? '', req.headers, web)) {
          req.resume();
          return send(res, 401, { error: 'token required' });
        }
        if (crossOrigin(req)) {
          req.resume();
          return send(res, 403, { error: 'cross-origin request refused' });
        }
        trackRequest(res);
        await handleServerFileListRoute(req, res, url);
        return;
      }

      // ?token= on a LAN link sets the cookie once, then the URL drops it. Lax, not Strict: the link is
      // usually opened from another app, and Strict cookies are withheld on that cross-site redirect.
      // Writes stay protected by the crossOrigin() check.
      const linkToken = url.searchParams.get('token');
      if (linkToken && web.lan && web.token && sameSecret(linkToken, web.token)) {
        res.writeHead(302, { 'set-cookie': `timbre_token=${web.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`, location: url.pathname });
        res.end();
        return;
      }
      if (PUBLIC_PWA_ASSETS.has(url.pathname)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
        return serveStatic(res, url.pathname, false);
      }
      if (!authorize(req.socket.remoteAddress ?? '', req.headers, web)) return send(res, 401, { error: 'token required' });
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && crossOrigin(req)) return send(res, 403, { error: 'cross-origin write refused' });
        const isBackupRestore = isBackupRestoreRoute(matchBackupRoute(url.pathname));
        if (backupRoutes.isRestoring() && !isBackupRestore) {
          req.resume();
          return send(res, 409, { error: 'backup restore is in progress' });
        }
        const isTestCallStream = req.method === 'GET' && matchTestCallRoute(url.pathname)?.action === 'events';
        const isActivityStream = req.method === 'GET' && matchActivityEventsRoute(url.pathname);
        if (!isBackupRestore && !isTestCallStream && !isActivityStream) trackRequest(res);
        return api(req, res, url);
      }
      serveStatic(res, url.pathname);
    })().catch((err) => {
      opts.log(`http ${req.method} ${req.url}: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
      else res.end();
    });
  });
  server.on(WEB_SERVER_PRE_CLOSE, () => liveCallStreams.closeAll());
  server.on('close', () => { liveCallStreams.closeAll(); searchIndex.dispose(); backupRoutes.dispose(); });
  server.on('listening', () => {
    searchIndex.start();
    for (const phone of store.get().phones) void searchIndex.warmPhone(phone.id);
  });
  return server;
}
