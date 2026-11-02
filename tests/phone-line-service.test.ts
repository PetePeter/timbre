import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PhoneLineService } from '../src/phone/phone-line-service.js';
import { TelefonyProcess } from '../src/phone/telefony-process.js';
import { resolvePhoneLineConfig, type PhoneLineConfig } from '../src/phone/phone-config.js';
import type { RecordEvent } from '../src/records/event-types.js';
import { FakePhapServer } from './helpers/fake-phap-server.js';

const OWNER = '+61491570156';
const RECEPTION = '+61491570187';
const until = async (pred: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'helm-phoneline-'));
  const live = path.join(dir, 'live.js');
  writeFileSync(live, 'setInterval(() => {}, 1000)');
  const server = new FakePhapServer();
  await server.listen();
  const port = Number(new URL(server.uri).port);
  let cfg: PhoneLineConfig = resolvePhoneLineConfig({
    enabled: true, transport: 'usb:x', token: 'tok', port, heartbeatS: 1,
    voice: { tts: '', piperModel: '', sapiVoice: '', sttModel: 'test-stt' },
    masters: { callIn: true, callOut: true, smsIn: true, smsOut: true, conference: true },
    contacts: [
      { label: 'Me', pattern: OWNER, role: 'owner', callIn: true, callOut: true, smsIn: true, smsOut: true, conf: true },
      { label: 'Reception', pattern: RECEPTION, role: 'trusted', callIn: true, callOut: true, smsIn: false, smsOut: false, conf: true },
    ],
  });
  const recordingsDir = path.join(dir, 'phones', 'phone-line', 'recordings');
  let executable = 'C:/phap/shared-server.exe';
  const proc = new TelefonyProcess({
    configPath: path.join(dir, 'phones', 'phone-line', 'telefony.toml'),
    recordingsDir,
    spawnFn: ((_e: string, args: string[], o: object) => spawn(process.execPath, [live, ...args], o)) as unknown as typeof spawn,
  });
  const records: RecordEvent[] = [];
  const serviceDeps = {
    phoneId: 'service-phone',
    getConfig: () => cfg,
    saveConfig: (c: PhoneLineConfig) => { cfg = c; },
    getExecutable: () => executable,
    telefonyConfigPath: path.join(dir, 'telefony.toml'),
    recordingsDir,
    defaultTranscriptDir: dir,
    getAppVersion: () => 't',
    getOperatorId: () => 'op',
    sessionName: () => 'Operator',
    deliver: async () => undefined,
    log: () => undefined,
    recordEvent: (event: RecordEvent) => records.push(event),
    lookupAddressBook: () => [{ id: 'reception', name: 'Reception', numbers: [RECEPTION], group: 'Work', trusted: false, isUser: false, transferTarget: true, defaultTransfer: true }],
    process: proc,
  };
  const service = new PhoneLineService(serviceDeps);
  cleanup.push(() => service.stop(), () => server.close(), () => rmSync(dir, { recursive: true, force: true }));
  return { server, service, proc, dir, records, getCfg: () => cfg, setCfg: (c: Partial<PhoneLineConfig>) => { cfg = { ...cfg, ...c }; }, setExecutable: (next: string) => { executable = next; } };
}

const pid = (s: PhoneLineService) => (s.getStatus().process as { pid?: number }).pid;

describe('PhoneLineService', () => {
  it('routes a phone-book transfer through the active PhoneBridge', async () => {
    const { server, service } = await setup();
    await service.apply();
    await until(() => service.isAvailable());
    server.emit('call.ringing', { callId: 'c1', number: OWNER, allowed: true });
    await server.waitFor('call.answer');
    server.emit('call.state', { callId: 'c1', state: 'active' });
    await until(() => service.getStatus().line?.call?.state === 'active');

    await expect(service.transferToContact('op')).resolves.toEqual({ transferred: true, contactName: 'Reception' });
    expect(await server.waitFor('conference.create')).toEqual({ callId: 'c1', number: RECEPTION });
  });

  it('persists tool action metadata without caller arguments', async () => {
    const { service, records } = await setup();
    service.recordAgentToolCall('tool-1', 'phone_inbox', 'started');
    service.recordAgentToolCall('tool-1', 'phone_inbox', 'completed');

    expect(records).toHaveLength(2);
    expect(records.map(({ type }) => type)).toEqual(['agent.tool_started', 'agent.tool_finished']);
    expect(records.map(({ details }) => details)).toEqual([
      { toolName: 'phone_inbox' },
      { toolName: 'phone_inbox', outcome: 'completed' },
    ]);
  });

  it('starts the phone process with the shared install executable', async () => {
    const { service, proc, setExecutable } = await setup();
    const start = vi.spyOn(proc, 'start');

    await service.apply();
    setExecutable('D:/phap/shared-server.exe');
    await service.apply();

    expect(start).toHaveBeenCalledWith(expect.anything(), 'C:/phap/shared-server.exe');
    expect(start).toHaveBeenNthCalledWith(2, expect.anything(), 'D:/phap/shared-server.exe');
  });

  it('restarts an idle line when only its Bluetooth name changes', async () => {
    const { service, proc, dir, setCfg } = await setup();
    await service.apply();
    const firstPid = pid(service);
    expect(firstPid).toBeDefined();

    setCfg({ deviceName: 'Timbre - Work' });
    await service.apply();
    await until(() => pid(service) !== firstPid);

    expect(readFileSync(path.join(dir, 'phones', 'phone-line', 'telefony.toml'), 'utf8'))
      .toContain('name = "Timbre - Work"');
  });

  it('starts controller live audio only for an active call and stops it when the listener closes', async () => {
    const { server, service } = await setup();
    await service.apply();
    await until(() => service.isAvailable());
    server.emit('call.ringing', { callId: 'c1', number: OWNER, allowed: true });
    await server.waitFor('call.answer');
    server.emit('call.state', { callId: 'c1', state: 'active' });
    await until(() => service.getStatus().line?.call?.state === 'active');

    const received: Array<{ type: string; sequence?: number }> = [];
    const close = await service.openLiveAudioStream('c1', (event) => {
      received.push(event.type === 'frame' ? { type: 'frame', sequence: event.frame.sequence } : { type: 'ended' });
    });
    await server.waitFor('call.audio.start');
    server.emit('call.audio.frame', {
      callId: 'c1', sequence: 1, sampleRate: 8000, channels: 2, encoding: 'pcm_s16le',
      data: Buffer.alloc(640).toString('base64'),
    });
    await until(() => received.length === 1);
    expect(received).toEqual([{ type: 'frame', sequence: 1 }]);

    close();
    await server.waitFor('call.audio.stop');
    server.emit('call.audio.frame', {
      callId: 'c1', sequence: 2, sampleRate: 8000, channels: 2, encoding: 'pcm_s16le',
      data: Buffer.alloc(640).toString('base64'),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
  });

  it('passes its explicit phone id through to exported transcripts', async () => {
    const { server, service, dir, getCfg, setCfg } = await setup();
    setCfg({ transcripts: { ...getCfg().transcripts, format: 'both', smsSummary: false, fileName: 'transcript' } });
    server.handlers.set('transcript.get', () => ({ callId: 'c1', utterances: [] }));
    await service.apply();
    await until(() => service.isAvailable());

    server.emit('call.ringing', { callId: 'c1', number: OWNER, allowed: true });
    await server.waitFor('call.answer');
    server.emit('call.state', { callId: 'c1', state: 'active' });
    await until(() => service.getStatus().line?.call?.state === 'active');
    server.emit('call.state', { callId: 'c1', state: 'ended', reason: 'remote' });
    await until(() => readdirSync(dir, { recursive: true }).some((file) => String(file) === 'transcript.md'));

    const md = readFileSync(path.join(dir, 'transcript.md'), 'utf8');
    const json = JSON.parse(readFileSync(path.join(dir, 'transcript.json'), 'utf8'));
    expect(md).toContain('phone_id: "service-phone"');
    expect(json.phoneId).toBe('service-phone');
  });

  it('runs a virtual call through the configured bridge and refuses shared SMS and call actions', async () => {
    const { server, service, getCfg } = await setup();
    await service.apply();
    await until(() => service.isAvailable());

    const { callId } = service.startTestCall(OWNER);
    await until(() => service.getStatus().line?.call?.state === 'active');
    expect(await service.sendSms(getCfg().contacts[0], 'must stay virtual')).toMatchObject({ sent: false });
    await expect(service.startCallAgent('op', { to: OWNER, task: 'Call back' })).rejects.toThrow(/test call/i);
    await expect(service.startOwnerCallAgent({ to: OWNER, task: 'Call back' }, 'Switchboard')).rejects.toThrow(/test call/i);
    await expect(service.conferenceAdd('op', 'Me')).rejects.toThrow(/test call/i);
    await service.endTestCall(callId);
    await until(() => service.getStatus().line?.call === null);

    expect(server.requests.map(({ method }) => method)).not.toContain('call.answer');
    expect(server.requests.map(({ method }) => method)).not.toContain('call.dial');
    expect(server.requests.map(({ method }) => method)).not.toContain('sms.send');
    expect(server.requests.map(({ method }) => method)).not.toContain('conference.create');
  });

  it('starts telefony and the link, and defers a config restart until the call ends', async () => {
    const { server, service, setCfg } = await setup();
    await service.apply();
    await until(() => service.isAvailable());
    const first = pid(service);
    expect(first).toBeDefined();

    server.emit('call.ringing', { callId: 'c1', number: OWNER, allowed: true });
    await server.waitFor('call.answer');
    server.emit('call.state', { callId: 'c1', state: 'active' });
    await until(() => service.getStatus().line?.call?.state === 'active');

    setCfg({ voice: { tts: 'none', piperModel: '', sapiVoice: '', sttModel: 'base.en' } });
    await service.apply();
    expect(service.getStatus().pendingRestart).toBe(true);
    expect(pid(service)).toBe(first);
    await expect(service.restart()).rejects.toThrow(/call is live/);

    server.emit('call.state', { callId: 'c1', state: 'ended', reason: 'remote' });
    await until(() => !service.getStatus().pendingRestart && pid(service) !== first);
  });

  it('retries a deferred restart after the ended test call stream closes', async () => {
    const { service, setCfg } = await setup();
    await service.apply();
    await until(() => service.isAvailable());
    const first = pid(service);
    const { callId } = service.startTestCall(OWNER);
    const closeStream = service.openTestCallStream(callId, () => {});
    await until(() => service.getStatus().line?.call?.state === 'active');

    setCfg({ voice: { tts: 'none', piperModel: '', sapiVoice: '', sttModel: 'base.en' } });
    await service.apply();
    expect(service.getStatus().pendingRestart).toBe(true);
    expect(pid(service)).toBe(first);

    service.endTestCall(callId);
    await until(() => service.getStatus().line?.call === null);
    closeStream();
    await until(() => !service.getStatus().pendingRestart && pid(service) !== first);
  });

  it('a settings save that changes nothing telefony reads does not restart it', async () => {
    const { service, setCfg } = await setup();
    await service.apply();
    const first = pid(service);
    setCfg({ persona: { ...resolvePhoneLineConfig({}).persona, name: 'Sam' } });
    await service.apply();
    expect(pid(service)).toBe(first);
  });

  it('generates a token when none is set, and disabling hangs up and stops', async () => {
    const { server, service, setCfg, getCfg } = await setup();
    setCfg({ token: '' });
    await service.apply();
    expect(getCfg().token).toMatch(/^[\w-]{32}$/);
    setCfg({ token: 'tok' });
    await service.apply();
    await until(() => service.isAvailable());
    server.emit('call.ringing', { callId: 'c1', number: OWNER, allowed: true });
    await server.waitFor('call.answer');
    server.emit('call.state', { callId: 'c1', state: 'active' });
    await until(() => service.getStatus().line?.call?.state === 'active');
    setCfg({ enabled: false });
    await service.apply();
    expect(await server.waitFor('call.hangup')).toEqual({ callId: 'c1' });
    expect(service.getStatus().process.state).toBe('stopped');
  });
});
