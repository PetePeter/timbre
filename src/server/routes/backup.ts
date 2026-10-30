import { createReadStream } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConfigStore } from '../../config/timbre-config.js';
import { redactMcpSecrets } from '../../config/timbre-config.js';
import { beginRestoreTransaction } from '../../config/restore-transaction.js';
import type { Hub } from '../../hub.js';
import { createBackup, prepareBackupRestore } from '../../backup/backup-service.js';
import { BackupSizeLimitError } from '../../backup/archive.js';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const TICKET_LIFETIME_MS = 2 * 60_000;

export type BackupRoute = { action: 'create' | 'import' } | { action: 'download'; ticket: string };

export interface BackupRouteOptions {
  dataDir: string;
  store: ConfigStore;
  hub: Hub;
  log: (message: string) => void;
  readJson: (req: IncomingMessage) => Promise<unknown>;
  beforeRestore?: () => Promise<void>;
  onWebConfigChange?: () => Promise<void>;
  onRestore?: () => void;
}

interface DownloadTicket { directory: string; file: string; timer: ReturnType<typeof setTimeout> }

export function matchBackupRoute(pathname: string): BackupRoute | null {
  if (pathname === '/api/backup/export') return { action: 'create' };
  if (pathname === '/api/backup/import') return { action: 'import' };
  const download = /^\/api\/backup\/export\/([\w-]{36})$/.exec(pathname);
  return download ? { action: 'download', ticket: download[1] } : null;
}

export function createBackupRoutes(options: BackupRouteOptions): {
  handle(req: IncomingMessage, res: ServerResponse, route: BackupRoute): Promise<void>;
  isRestoring(): boolean;
  dispose(): void;
} {
  const tickets = new Map<string, DownloadTicket>();
  let restoring = false;

  async function handle(req: IncomingMessage, res: ServerResponse, route: BackupRoute): Promise<void> {
    if (restoring) { req.resume(); return json(res, 409, { error: 'backup restore is already in progress' }); }
    if (route.action === 'import') {
      restoring = true;
      try { await restore(req, res); }
      finally { restoring = false; }
      return;
    }
    if (route.action === 'create') return create(req, res);
    if (route.action === 'download') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      return download(res, route.ticket);
    }
    return json(res, 404, { error: 'not found' });
  }

  async function create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const body = await options.readJson(req) as { includeRecords?: unknown; includeSecrets?: unknown; passphrase?: unknown };
    if (body.includeRecords !== undefined && typeof body.includeRecords !== 'boolean'
      || body.includeSecrets !== undefined && typeof body.includeSecrets !== 'boolean'
      || body.passphrase !== undefined && typeof body.passphrase !== 'string') {
      return json(res, 400, { error: 'backup options are invalid' });
    }
    let archive: Buffer;
    try {
      archive = createBackup(options.dataDir, options.store.get(), {
        includeRecords: body.includeRecords === true,
        includeSecrets: body.includeSecrets === true,
        passphrase: body.passphrase as string | undefined,
        maxArchiveBytes: MAX_ARCHIVE_BYTES,
      });
    } catch (err) {
      return json(res, err instanceof BackupSizeLimitError ? 413 : 400, {
        error: err instanceof BackupSizeLimitError ? 'backup exceeds the 128 MB archive limit' : (err as Error).message,
      });
    }

    const directory = mkdtempSync(path.join(tmpdir(), 'timbre-backup-'));
    const file = path.join(directory, 'backup.json');
    try {
      writeFileSync(file, archive, { flag: 'wx', mode: 0o600 });
      const ticket = randomUUID();
      const timer = setTimeout(() => removeTicket(ticket), TICKET_LIFETIME_MS);
      timer.unref?.();
      tickets.set(ticket, { directory, file, timer });
      return json(res, 201, { ticket, fileName: `timbre-backup-${new Date().toISOString().slice(0, 10)}.json` });
    } catch (err) {
      rmSync(directory, { recursive: true, force: true });
      throw err;
    }
  }

  function download(res: ServerResponse, ticket: string): void {
    const entry = tickets.get(ticket);
    if (!entry) return json(res, 404, { error: 'backup download expired or was already used' });
    tickets.delete(ticket);
    clearTimeout(entry.timer);
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="timbre-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      'cache-control': 'no-store',
    });
    const stream = createReadStream(entry.file);
    const cleanup = () => rmSync(entry.directory, { recursive: true, force: true });
    res.once('close', cleanup);
    stream.once('error', (err) => {
      cleanup();
      options.log(`backup download failed: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: 'backup download failed' });
      else res.destroy(err);
    });
    stream.pipe(res);
  }

  async function restore(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    let source: Buffer;
    try { source = await readBounded(req, MAX_ARCHIVE_BYTES); }
    catch (err) {
      const tooLarge = err instanceof RangeError;
      return json(res, tooLarge ? 413 : 400, { error: tooLarge ? 'backup exceeds the 128 MB archive limit' : 'backup upload could not be read' });
    }
    let passphrase: string | undefined;
    const encodedPassphrase = req.headers['x-timbre-backup-passphrase'];
    if (encodedPassphrase) {
      try { passphrase = decodeURIComponent(Array.isArray(encodedPassphrase) ? encodedPassphrase[0] : encodedPassphrase); }
      catch { return json(res, 400, { error: 'backup passphrase header is invalid' }); }
    }
    let prepared;
    try { prepared = prepareBackupRestore(options.dataDir, source, passphrase); }
    catch (err) { return json(res, 400, { error: (err as Error).message }); }
    await options.beforeRestore?.();

    const previous = structuredClone(options.store.get());
    let hubMayNeedRestart = false;
    let transaction: ReturnType<typeof beginRestoreTransaction> | undefined;
    try {
      hubMayNeedRestart = true;
      await options.hub.stop();
      transaction = beginRestoreTransaction(options.dataDir, prepared.files);
      transaction.commit();
      options.store.adoptRestored(prepared.config);
      if (previous.web.port !== prepared.config.web.port || previous.web.lan !== prepared.config.web.lan) {
        await options.onWebConfigChange?.();
      }
      await options.hub.apply();
      options.onRestore?.();
      transaction.finalize();
      return json(res, 200, { ok: true, config: redactMcpSecrets(options.store.get()) });
    } catch (err) {
      let rollbackError: unknown;
      try { transaction?.rollback(); } catch (failed) { rollbackError = failed; }
      options.store.adoptRestored(previous);
      if (previous.web.port !== prepared.config.web.port || previous.web.lan !== prepared.config.web.lan) {
        try { await options.onWebConfigChange?.(); } catch (failed) { rollbackError ??= failed; }
      }
      if (hubMayNeedRestart && !rollbackError) {
        try { await options.hub.apply(); } catch (failed) { rollbackError = failed; }
      }
      if (!rollbackError) {
        try { options.onRestore?.(); } catch (failed) { rollbackError = failed; }
      }
      const reason = rollbackError ? `restore failed and rollback needs recovery: ${(rollbackError as Error).message}` : `restore failed: ${(err as Error).message}`;
      options.log(reason);
      return json(res, 500, { error: reason });
    }
  }

  function removeTicket(ticket: string): void {
    const entry = tickets.get(ticket);
    if (!entry) return;
    tickets.delete(ticket);
    clearTimeout(entry.timer);
    rmSync(entry.directory, { recursive: true, force: true });
  }

  return {
    handle,
    isRestoring: () => restoring,
    dispose() {
      for (const ticket of [...tickets.keys()]) removeTicket(ticket);
    },
  };
}

async function readBounded(req: IncomingMessage, maximum: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new RangeError('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
