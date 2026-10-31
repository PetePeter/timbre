/** Entry point: load config, start the phones, serve the UI. */
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ConfigStore, dataDir } from '../config/timbre-config.js';
import { Hub } from '../hub.js';
import { createServer } from './server.js';
import { WebServerRuntime } from './web-server-runtime.js';
import { createRotatingLog } from '../util/rotating-log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const version = (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
const dir = dataDir();
mkdirSync(dir, { recursive: true });
const serverLog = createRotatingLog(path.join(dir, 'timbre.log'), (err) => console.error(`${new Date().toISOString()} Timbre log write failed: ${err.message}`));
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  serverLog.write(`${line}\n`);
};

const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
const hub = new Hub({ store, dataDir: dir, version, log, mcpUrl: (id) => `http://127.0.0.1:${store.get().web.port}/mcp/${id}` });
let runtime!: WebServerRuntime;
const server = createServer({
  hub, store, staticDir: path.join(repoRoot, 'dist', 'web'), repositoryRoot: repoRoot, log,
  onWebConfigChange: () => runtime.rebind(),
});
runtime = new WebServerRuntime(server, store, log);

void runtime.start().then(() => {
  const { lan, token } = store.get().web;
  const { port } = server.address() as AddressInfo;
  log(`Timbre ${version} — config ${dir}`);
  log(`Local:  http://localhost:${port}`);
  if (lan) {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) log(`LAN:    http://${a.address}:${port}/?token=${token}`);
    }
  }
  void hub.apply().catch((err) => log(`start failed: ${(err as Error).message}`));
}).catch((err) => log(`web server start failed: ${(err as Error).message}`));

const shutdown = () => {
  void Promise.allSettled([hub.stop(), runtime.stop()]).finally(() => {
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      process.exit(0);
    };
    serverLog.once('finish', exit);
    serverLog.once('close', exit);
    serverLog.end();
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
