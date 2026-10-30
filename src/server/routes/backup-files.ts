import { createReadStream, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function resolveBackupDirectory(requestedPath: string, repositoryRoot: string): string {
  if (!path.isAbsolute(requestedPath)) throw new Error('server backup folder must be an absolute path');
  let directory: string;
  try { directory = realpathSync(requestedPath); }
  catch { throw new Error('server backup folder does not exist'); }
  if (!statSync(directory).isDirectory()) throw new Error('server backup path must be a folder');
  if (isWithin(repositoryRoot, path.resolve(requestedPath)) || isWithin(repositoryRoot, directory)) {
    throw new Error('server backup folder cannot be inside the application repository');
  }
  return directory;
}

export function writeServerBackup(directory: string, archive: Buffer, now = new Date()): { path: string; fileName: string } {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  for (let suffix = 0; suffix < 1000; suffix++) {
    const fileName = `timbre-backup-${timestamp}${suffix ? `-${suffix}` : ''}.json`;
    const targetPath = path.join(directory, fileName);
    try {
      writeFileSync(targetPath, archive, { flag: 'wx', mode: 0o600 });
      return { path: targetPath, fileName };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('could not create a unique server backup filename');
}

export async function readServerBackupFile(requestedPath: string, repositoryRoot: string, maximum: number): Promise<Buffer> {
  if (!path.isAbsolute(requestedPath)) throw new Error('server backup file must be an absolute path');
  if (path.extname(requestedPath).toLowerCase() !== '.json') throw new Error('server backup file must have a .json extension');
  let file: string;
  try { file = realpathSync(requestedPath); }
  catch { throw new Error('server backup file does not exist'); }
  if (isWithin(repositoryRoot, path.resolve(requestedPath)) || isWithin(repositoryRoot, file)) {
    throw new Error('server backup file cannot be inside the application repository');
  }
  if (!statSync(file).isFile()) throw new Error('server backup path must be a file');

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new RangeError('backup exceeds the 128 MB archive limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const root = realpathSync(rootPath);
  const relative = path.relative(root, candidatePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
