import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelefonyProcess, renderTelefonyToml, type TelefonyProcessOptions, type TelefonyStatus } from '../src/phone/telefony-process.js';
import { resolvePhoneLineConfig } from '../src/phone/phone-config.js';
import { readTelefonyAdminToken, telefonyAdminPort } from '../src/phone/setup/telefony-admin.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'helm-telefony-'));
const script = (name: string, body: string) => { const p = path.join(dir, name); writeFileSync(p, body); return p; };
const phoneConfigPath = (id: string) => path.join(dir, 'phones', id, 'telefony.toml');
const recordingsDir = (id: string) => path.join(dir, 'phones', id, 'recordings');
const processFor = (id: string, options: Partial<Omit<TelefonyProcessOptions, 'configPath' | 'recordingsDir'>> = {}) =>
  new TelefonyProcess({ configPath: phoneConfigPath(id), recordingsDir: recordingsDir(id), ...options });
const CRASH = script('crash.js', 'process.exit(3)');
const LIVE = script('live.js', 'setInterval(() => {}, 1000)');

/** Runs a node script in place of telefony-app; the TOML path is still passed through. */
const nodeRunning = (file: string) => ((_exe: string, args: string[], o: object) => spawn(process.execPath, [file, ...args], o)) as unknown as typeof spawn;

const cfg = (over: Record<string, unknown> = {}) => resolvePhoneLineConfig({
  enabled: true, executable: 'telefony-app', transport: 'usb:10D7:B012', token: 'tok', countryCode: '+61',
  contacts: [
    { label: 'Me', pattern: '0491570156', role: 'owner', callIn: true, callOut: true, smsIn: true, smsOut: true, conf: true },
    { label: 'Office', pattern: '+61299*', role: 'trusted', callIn: true },
    { label: 'Spam', pattern: '+61400000000', role: 'trusted', callIn: true },
    { label: 'Dormant', pattern: '+61411111111', role: 'trusted' },
  ],
  blocklist: ['^0400000000$'],
  ...over,
});

const procs: TelefonyProcess[] = [];
afterEach(async () => { await Promise.all(procs.splice(0).map((p) => p.stop())); });

function waitFor(p: TelefonyProcess, pred: (s: TelefonyStatus) => boolean, ms = 5000): Promise<TelefonyStatus> {
  return new Promise((resolve, reject) => {
    if (pred(p.getStatus())) return resolve(p.getStatus());
    const t = setTimeout(() => reject(new Error(`timeout; last ${JSON.stringify(p.getStatus())}`)), ms);
    p.on('status', (s: TelefonyStatus) => { if (pred(s)) { clearTimeout(t); resolve(s); } });
  });
}

describe('renderTelefonyToml', () => {
  const admin = { port: 30123, token: 'private-admin-token' };
  it('allowlists only exact, enabled, non-blocked numbers, normalised', () => {
    const toml = renderTelefonyToml(cfg(), admin, recordingsDir('render'));
    expect(toml).toContain('allowlist = ["+61491570156"]');
    expect(toml).toContain('bind = "127.0.0.1:7781"');
    expect(toml).toContain('bind = "127.0.0.1:30123"');
    expect(toml).toContain('admin_token = "private-admin-token"');
    expect(toml).toContain('token = "tok"');
    expect(toml).not.toContain('piper_model');
  });
  it('lets Timbre dial any number: the dial-out guard lives in Timbre, not the allowlist', () => {
    const policy = renderTelefonyToml(cfg(), admin, recordingsDir('render')).split('[policy]')[1].split(/\n\[/)[0];
    expect(policy).toContain('\noutbound = "all"\n');
  });
  it('quotes values safely', () => {
    expect(renderTelefonyToml(cfg({ transport: 'a"b\\c' }), admin, recordingsDir('render'))).toContain('transport = "a\\"b\\\\c"');
  });
  it('writes an absolute Piper model or the selected SAPI voice for this phone', () => {
    const model = path.resolve(dir, 'voices', 'clone.onnx');
    const piperToml = renderTelefonyToml(cfg({ voice: { tts: 'piper', piperModel: model, sttModel: '', sapiVoice: '' } }), admin, recordingsDir('render'));
    const sapiToml = renderTelefonyToml(cfg({ voice: { tts: 'sapi', piperModel: '', sttModel: '', sapiVoice: 'Microsoft Hazel Desktop' } }), admin, recordingsDir('render'));

    expect(piperToml).toContain(`piper_model = ${JSON.stringify(model)}`);
    expect(piperToml).not.toContain('sapi_voice');
    expect(sapiToml).toContain('sapi_voice = "Microsoft Hazel Desktop"');
    expect(sapiToml).not.toContain('piper_model');
  });
});

describe('TelefonyProcess', () => {
  it('stops retrying when the Bluetooth dongle is missing', async () => {
    const NO_DONGLE = script('nodongle.js', 'process.stderr.write("telefony-app: dongle not found\\n(device not found; check it is plugged in)\\n"); process.exit(3)');
    const p = processFor('nd', { spawnFn: nodeRunning(NO_DONGLE), baseDelayMs: 10 });
    procs.push(p);
    await p.start(cfg());
    const s = await waitFor(p, (st) => st.state === 'failed');
    expect(s).toMatchObject({ state: 'failed', lastError: expect.stringMatching(/dongle not found/) });
  });

  it('writes the TOML and passes its path to the process', async () => {
    const configPath = phoneConfigPath('a');
    const p = processFor('a', { spawnFn: nodeRunning(LIVE) });
    procs.push(p);
    await p.start(cfg());
    expect(p.getStatus().state).toBe('running');
    expect(readFileSync(configPath, 'utf8')).toContain('[policy]');
    expect(readFileSync(configPath, 'utf8')).toContain(`[recordings]\ndirectory = ${JSON.stringify(recordingsDir('a'))}`);
    expect(existsSync(recordingsDir('a'))).toBe(true);
  });

  it('keeps a stable per-phone admin token in a sidecar and writes the loopback port', async () => {
    const configPath = phoneConfigPath('private-phone');
    const p = processFor('private-phone');
    const first = await p.renderConfig(cfg());
    const token = await readTelefonyAdminToken(configPath);
    expect(token).toBeTruthy();
    expect(token?.length).toBeGreaterThanOrEqual(32);
    expect(first).toContain(`[web]\nbind = "127.0.0.1:${await telefonyAdminPort('private-phone', path.join(dir, 'phones'))}"`);
    expect(first).toContain(`admin_token = "${token}"`);
    expect(await p.renderConfig(cfg())).toBe(first);
    expect(await readTelefonyAdminToken(configPath)).toBe(token);
  });

  it('restarts a crashing process with backoff, then gives up', async () => {
    const p = processFor('b', { spawnFn: nodeRunning(CRASH), baseDelayMs: 10, maxRestarts: 2 });
    procs.push(p);
    const seen: TelefonyStatus[] = [];
    p.on('status', (s) => seen.push(s));
    await p.start(cfg());
    const final = await waitFor(p, (s) => s.state === 'failed');
    expect(final).toMatchObject({ state: 'failed' });
    expect(seen.filter((s) => s.state === 'backoff').map((s) => (s as { restartInMs: number }).restartInMs)).toEqual([10, 20]);
  });

  it('does not restart when the watchdog is off', async () => {
    const p = processFor('c', { spawnFn: nodeRunning(CRASH), baseDelayMs: 10 });
    procs.push(p);
    await p.start(cfg({ watchdog: false }));
    await waitFor(p, (s) => s.state === 'failed');
  });

  it('re-applying settings to a running process restarts it without a crash backoff', async () => {
    const p = processFor('e', { spawnFn: nodeRunning(LIVE), baseDelayMs: 10 });
    procs.push(p);
    await p.start(cfg());
    const seen: string[] = [];
    p.on('status', (s: TelefonyStatus) => seen.push(s.state));
    await Promise.all([p.start(cfg()), p.start(cfg())]);
    expect(seen).not.toContain('backoff');
    expect(p.getStatus()).toMatchObject({ state: 'running', restarts: 0 });
  });

  it('restart() on a dead link kills and relaunches; stop() kills for good', async () => {
    const p = processFor('d', { spawnFn: nodeRunning(LIVE), baseDelayMs: 10 });
    procs.push(p);
    await p.start(cfg());
    const first = p.getStatus() as { pid: number };
    await p.restart('no heartbeat');
    const again = await waitFor(p, (s) => s.state === 'running') as { pid: number };
    expect(again.pid).not.toBe(first.pid);
    await p.stop();
    expect(p.getStatus().state).toBe('stopped');
    expect(() => process.kill(again.pid, 0)).toThrow();
  });
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
