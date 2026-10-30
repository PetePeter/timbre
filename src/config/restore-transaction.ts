import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const TRANSACTION_DIR = '.backup-restore';
const MANIFEST = 'manifest.json';
const PHONE_ID = /^[\w-]{1,100}$/;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const activeRoots = new Set<string>();

export interface RestoreFileChange {
  path: string;
  content?: Uint8Array;
  delete?: boolean;
}

interface ManifestEntry {
  path: string;
  hadOriginal: boolean;
  originalMode?: number;
  delete: boolean;
  staged?: string;
  backup?: string;
}

interface TransactionManifest {
  version: 1;
  committed: boolean;
  entries: ManifestEntry[];
}

export interface RestoreTransaction {
  /** Apply staged file changes while retaining rollback copies and the recovery journal. */
  commit(): void;
  /** Mark the transaction complete and discard its recovery data. */
  finalize(): void;
  /** Restore the pre-transaction file set and discard the recovery data. */
  rollback(): void;
}

export function beginRestoreTransaction(dataDir: string, changes: RestoreFileChange[]): RestoreTransaction {
  const requestedRoot = path.resolve(dataDir);
  if (activeRoots.has(pathExists(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot)) throw new Error('A backup restore transaction is already active.');
  recoverRestoreTransaction(requestedRoot);
  if (!changes.length) throw new Error('A backup restore contains no files.');
  const seen = new Set<string>();
  const validated = changes.map((change) => {
    validateRelativePath(change.path);
    const key = change.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Backup restore contains a duplicate path: ${change.path}`);
    seen.add(key);
    if ((change.content === undefined) === (change.delete !== true)) throw new Error(`Backup restore change is invalid: ${change.path}`);
    return { ...change, target: safeTarget(requestedRoot, change.path) };
  });

  mkdirSync(requestedRoot, { recursive: true });
  const root = realpathSync(requestedRoot);
  if (activeRoots.has(root)) throw new Error('A backup restore transaction is already active.');
  const workRoot = path.join(root, TRANSACTION_DIR);
  if (pathExists(workRoot)) throw new Error('A previous backup restore transaction could not be recovered.');
  mkdirSync(workRoot, { mode: 0o700 });
  const entries: ManifestEntry[] = [];
  activeRoots.add(root);
  try {
    validated.forEach((change, index) => {
      assertNoSymlinkParents(root, change.path);
      const hadOriginal = existsSync(change.target);
      if (hadOriginal && !lstatSync(change.target).isFile()) throw new Error(`Backup restore target is not a file: ${change.path}`);
      const entry: ManifestEntry = {
        path: change.path,
        hadOriginal,
        ...(hadOriginal ? { originalMode: lstatSync(change.target).mode & 0o777 } : {}),
        delete: change.delete === true,
        ...(change.delete === true ? {} : { staged: `${index}.new` }),
        ...(hadOriginal ? { backup: `${index}.old` } : {}),
      };
      if (entry.backup) {
        const backup = path.join(workRoot, entry.backup);
        copyFileSync(change.target, backup);
        chmodSync(backup, 0o600);
      }
      if (entry.staged) writeFileSync(path.join(workRoot, entry.staged), Buffer.from(change.content!), { flag: 'wx', mode: 0o600 });
      entries.push(entry);
    });
    writeManifest(workRoot, { version: 1, committed: false, entries });
  } catch (err) {
    rmSync(workRoot, { recursive: true, force: true });
    activeRoots.delete(root);
    throw err;
  }

  let finished = false;
  const release = () => { finished = true; activeRoots.delete(root); };
  return {
    commit() {
      if (finished) throw new Error('Backup restore transaction is already finished.');
      for (const entry of entries) {
        const target = safeTarget(root, entry.path);
        assertNoSymlinkParents(root, entry.path);
        if (entry.delete) {
          rmSync(target, { force: true });
          continue;
        }
        const folder = path.dirname(target);
        mkdirSync(folder, { recursive: true });
        const temp = `${target}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temp, readFileSync(path.join(workRoot, entry.staged!)), { flag: 'wx', mode: 0o600 });
          chmodSync(temp, 0o600);
          renameSync(temp, target);
        } finally {
          if (existsSync(temp)) rmSync(temp, { force: true });
        }
      }
    },
    finalize() {
      if (finished) throw new Error('Backup restore transaction is already finished.');
      writeManifest(workRoot, { version: 1, committed: true, entries });
      try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* Startup recovery removes committed journals. */ }
      release();
    },
    rollback() {
      if (finished) throw new Error('Backup restore transaction is already finished.');
      rollbackEntries(root, workRoot, entries);
      rmSync(workRoot, { recursive: true, force: true });
      release();
    },
  };
}

/** Roll back a transaction interrupted before its committed marker was written. */
export function recoverRestoreTransaction(dataDir: string): void {
  const requestedRoot = path.resolve(dataDir);
  if (!pathExists(requestedRoot)) return;
  const root = realpathSync(requestedRoot);
  const workRoot = path.join(root, TRANSACTION_DIR);
  if (!pathExists(workRoot)) return;
  if (activeRoots.has(root)) return;
  const workStat = lstatSync(workRoot);
  if (workStat.isSymbolicLink() || !workStat.isDirectory()) throw new Error('Backup restore journal path is unsafe.');
  const manifestPath = path.join(workRoot, MANIFEST);
  if (!pathExists(manifestPath)) {
    rmSync(workRoot, { recursive: true, force: true });
    return;
  }
  const manifestStat = lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error('Backup restore journal file is unsafe.');
  let manifest: TransactionManifest;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const value = parsed as TransactionManifest;
    if (value.version !== 1 || typeof value.committed !== 'boolean' || !Array.isArray(value.entries)) throw new Error();
    for (const entry of value.entries) validateManifestEntry(entry);
    manifest = value;
  } catch {
    throw new Error('Backup restore journal is invalid; managed files were left untouched.');
  }
  if (!manifest.committed) rollbackEntries(root, workRoot, manifest.entries);
  rmSync(workRoot, { recursive: true, force: true });
}

function rollbackEntries(root: string, workRoot: string, entries: ManifestEntry[]): void {
  for (const entry of [...entries].reverse()) {
    const target = safeTarget(root, entry.path);
    if (!entry.hadOriginal) {
      if (!pathExists(target)) continue;
      assertNoSymlinkParents(root, entry.path);
      rmSync(target, { force: true });
      continue;
    }
    assertNoSymlinkParents(root, entry.path);
    const backup = path.join(workRoot, entry.backup!);
    if (!existsSync(backup) || !lstatSync(backup).isFile()) throw new Error(`Backup restore recovery copy is missing: ${entry.path}`);
    mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.rollback`;
    try {
      writeFileSync(temp, readFileSync(backup), { flag: 'wx', mode: entry.originalMode ?? 0o600 });
      chmodSync(temp, entry.originalMode ?? 0o600);
      renameSync(temp, target);
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true });
    }
  }
}

function writeManifest(workRoot: string, manifest: TransactionManifest): void {
  const temp = path.join(workRoot, `${MANIFEST}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    renameSync(temp, path.join(workRoot, MANIFEST));
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

function validateManifestEntry(value: unknown): asserts value is ManifestEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest entry');
  const entry = value as ManifestEntry;
  validateRelativePath(entry.path);
  if (typeof entry.hadOriginal !== 'boolean' || typeof entry.delete !== 'boolean'
    || (entry.hadOriginal && (typeof entry.backup !== 'string' || !/^\d+\.old$/.test(entry.backup)
      || !Number.isInteger(entry.originalMode) || entry.originalMode! < 0 || entry.originalMode! > 0o777))
    || (!entry.hadOriginal && (entry.backup !== undefined || entry.originalMode !== undefined))
    || (entry.delete && entry.staged !== undefined)
    || (!entry.delete && (typeof entry.staged !== 'string' || !/^\d+\.new$/.test(entry.staged)))) {
    throw new Error('invalid manifest entry');
  }
}

function validateRelativePath(relative: string): void {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.startsWith('/') || relative.includes(':')) {
    throw new Error(`Backup restore path is invalid: ${String(relative)}`);
  }
  const parts = relative.split('/');
  const valid = relative === 'timbre.yaml'
    || (parts.length === 3 && parts[0] === 'phones' && PHONE_ID.test(parts[1])
      && (parts[2] === 'contacts.json' || parts[2] === 'contact-pins.json'))
    || (parts.length === 4 && parts[0] === 'phones' && PHONE_ID.test(parts[1])
      && parts[2] === 'events' && validDayFile(parts[3]));
  if (!valid || parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Backup restore path is not managed: ${relative}`);
}

function safeTarget(root: string, relative: string): string {
  validateRelativePath(relative);
  const target = path.resolve(root, ...relative.split('/'));
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Backup restore path is outside the data directory: ${relative}`);
  return target;
}

function assertNoSymlinkParents(root: string, relative: string): void {
  const target = safeTarget(root, relative);
  const rel = path.relative(root, target);
  const parts = rel.split(path.sep);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = pathExists(current) ? lstatSync(current) : undefined;
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`Backup restore path crosses a symbolic link: ${relative}`);
    if (current !== target && !stat.isDirectory()) throw new Error(`Backup restore path parent is not a directory: ${relative}`);
  }
}

function validDayFile(name: string): boolean {
  if (!DAY_FILE.test(name)) return false;
  const [year, month, day] = name.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function pathExists(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}
