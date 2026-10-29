import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ADMIN_PORT_START = 30_000;
const ADMIN_PORT_RANGE = 15_000;
const ADMIN_PORT_REGISTRY = 'telefony-admin-ports.json';

let portAllocationQueue: Promise<void> = Promise.resolve();

/** Allocate one stable, unique loopback port per phone in the shared phones data directory. */
export function telefonyAdminPort(phoneId: string, phonesDir: string): Promise<number> {
  const allocation = portAllocationQueue.then(() => allocateTelefonyAdminPort(phoneId, phonesDir));
  portAllocationQueue = allocation.then(() => undefined, () => undefined);
  return allocation;
}

async function allocateTelefonyAdminPort(phoneId: string, phonesDir: string): Promise<number> {
  const registryPath = path.join(phonesDir, ADMIN_PORT_REGISTRY);
  await fs.mkdir(phonesDir, { recursive: true });
  const allocations = await readPortRegistry(registryPath);
  const existing = allocations[phoneId];
  if (existing !== undefined) return existing;

  const used = new Set(Object.values(allocations));
  const first = createHash('sha256').update(phoneId).digest().readUInt32BE(0) % ADMIN_PORT_RANGE;
  let port: number | undefined;
  for (let offset = 0; offset < ADMIN_PORT_RANGE; offset++) {
    const candidate = ADMIN_PORT_START + ((first + offset) % ADMIN_PORT_RANGE);
    if (!used.has(candidate)) { port = candidate; break; }
  }
  if (port === undefined) throw new Error('telefony setup port range is exhausted');

  allocations[phoneId] = port;
  const tempPath = `${registryPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(allocations, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tempPath, registryPath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw err;
  }
  return port;
}

async function readPortRegistry(registryPath: string): Promise<Record<string, number>> {
  let raw: string;
  try { raw = await fs.readFile(registryPath, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as Record<string, number>;
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('telefony setup port registry is invalid');
  }
  const allocations: Record<string, number> = Object.create(null) as Record<string, number>;
  const used = new Set<number>();
  for (const [phoneId, port] of Object.entries(parsed)) {
    if (!Number.isInteger(port) || port < ADMIN_PORT_START || port >= ADMIN_PORT_START + ADMIN_PORT_RANGE || used.has(port)) {
      throw new Error('telefony setup port registry is invalid');
    }
    allocations[phoneId] = port;
    used.add(port);
  }
  return allocations;
}

export function telefonyAdminTokenPath(configPath: string): string {
  return path.join(path.dirname(configPath), 'telefony-admin.token');
}

/** Create the control token once per phone config directory and keep it out of UI config. */
export async function ensureTelefonyAdminToken(configPath: string): Promise<string> {
  const tokenPath = telefonyAdminTokenPath(configPath);
  try { return (await fs.readFile(tokenPath, 'utf8')).trim(); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }

  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString('base64url');
  try {
    const handle = await fs.open(tokenPath, 'wx', 0o600);
    try { await handle.writeFile(token, 'utf8'); }
    finally { await handle.close(); }
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return (await fs.readFile(tokenPath, 'utf8')).trim();
  }
}

export async function readTelefonyAdminToken(configPath: string): Promise<string | null> {
  try {
    const token = (await fs.readFile(telefonyAdminTokenPath(configPath), 'utf8')).trim();
    return token || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
