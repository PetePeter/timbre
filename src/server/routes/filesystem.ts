import { statSync } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_ENTRIES = 1000;
const FILE_LIST_PATH = '/api/fs/list';

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
}

interface FileListing {
  path: string;
  parentPath: string | null;
  roots: string[];
  entries: FileEntry[];
  truncated: boolean;
}

function windowsRoots(): string[] {
  const roots: string[] = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (statSync(root).isDirectory()) roots.push(root);
    } catch {
      // An absent or inaccessible drive is not a usable navigation root.
    }
  }
  return roots;
}

function roots(): string[] {
  return process.platform === 'win32' ? windowsRoots() : [path.parse(process.cwd()).root];
}

function parentPath(directory: string): string | null {
  const parent = path.dirname(directory);
  return parent === directory ? null : parent;
}

function extensionFilter(value: string | null): string | null {
  if (value === null || !value.trim()) return null;
  const extension = value.trim().toLowerCase();
  if (!/^\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(extension)) throw new Error('invalid extension filter');
  return extension;
}

async function listDirectory(directory: string, extension: string | null): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  const directories: string[] = [];
  const files: string[] = [];
  let matchingEntries = 0;
  for await (const item of await opendir(directory)) {
    let isDir = item.isDirectory();
    let isFile = item.isFile();
    if (item.isSymbolicLink()) {
      try {
        const metadata = await stat(path.join(directory, item.name));
        isDir = metadata.isDirectory();
        isFile = metadata.isFile();
      }
      catch { continue; }
    }
    if (!isDir && !isFile) continue;
    if (!isDir && extension && !item.name.toLowerCase().endsWith(extension)) continue;
    matchingEntries++;
    if (isDir && directories.length < MAX_ENTRIES) directories.push(item.name);
    else if (isFile && files.length < MAX_ENTRIES) files.push(item.name);
  }

  const compareNames = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: 'base' })
    || left.localeCompare(right);
  directories.sort(compareNames);
  const remaining = Math.max(0, MAX_ENTRIES - directories.length);
  const selectedFiles = files.sort(compareNames).slice(0, remaining);
  const fileEntries = await Promise.all(selectedFiles.map(async (name): Promise<FileEntry | null> => {
    try {
      const metadata = await stat(path.join(directory, name));
      return { name, isDir: false, size: metadata.size };
    } catch {
      // Skip entries that disappeared or whose metadata is not readable.
      return null;
    }
  }));
  const entries = [
    ...directories.map((name): FileEntry => ({ name, isDir: true, size: 0 })),
    ...fileEntries.filter((entry): entry is FileEntry => entry !== null),
  ];
  return { entries, truncated: matchingEntries > MAX_ENTRIES };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function errorResponse(error: unknown): { status: number; message: string } {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') return { status: 403, message: 'permission denied' };
  if (code === 'ENOENT') return { status: 404, message: 'directory not found' };
  if (code === 'ENOTDIR') return { status: 400, message: 'path is not a directory' };
  if (code === 'ERR_INVALID_ARG_VALUE' || code === 'EINVAL') return { status: 400, message: 'invalid path' };
  return { status: 500, message: 'unable to list directory' };
}

export function isServerFileListRoute(pathname: string): boolean {
  return pathname === FILE_LIST_PATH;
}

export async function handleServerFileListRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    req.resume();
    res.writeHead(405, { 'allow': 'GET', 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  let extension: string | null;
  try {
    extension = extensionFilter(url.searchParams.get('extension'));
  } catch {
    return send(res, 400, { error: 'invalid extension filter' });
  }

  const requestedPath = url.searchParams.get('path') ?? '';
  if (!requestedPath && process.platform === 'win32') {
    return send(res, 200, { path: '', parentPath: null, roots: windowsRoots(), entries: [], truncated: false } satisfies FileListing);
  }

  let directory: string;
  try {
    directory = path.resolve(requestedPath || path.parse(process.cwd()).root);
    const result = await listDirectory(directory, extension);
    return send(res, 200, {
      path: directory,
      parentPath: parentPath(directory),
      roots: roots(),
      ...result,
    } satisfies FileListing);
  } catch (error) {
    const failure = errorResponse(error);
    return send(res, failure.status, { error: failure.message });
  }
}
