import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import type { spawn as nodeSpawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseTelefonySetupDescriptor, TelefonySetupDescriptorError, TelefonySetupDescriptorReader,
} from '../src/phone/setup/telefony-setup-descriptor.js';

const directories: string[] = [];
function executable(name = 'telefony-app'): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'timbre-setup-descriptor-'));
  directories.push(directory);
  const file = path.join(directory, name);
  writeFileSync(file, 'fake executable');
  return file;
}

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
  close(code: number, stdout = ''): void {
    this.stdout.end(stdout);
    this.stderr.end();
    this.emit('close', code, null);
  }
}

function manifest(tts = 'auto') {
  return {
    provider: 'telefony-app', providerVersion: '1.2.3', setupVersion: 1,
    fields: [
      { key: 'voice.tts', label: 'Text-to-speech mode', type: 'enum', default: tts, choices: ['auto', 'piper', 'sapi', 'none'], restartRequired: true },
      { key: 'voice.piper_model', label: 'Piper model path', type: 'path', default: null },
      { key: 'voice.sapi_voice', label: 'SAPI voice', type: 'string', default: null },
      { key: 'voice.stt_model', label: 'Speech-to-text model', type: 'string', default: 'small.en', choices: ['none'] },
    ],
  };
}

function spawnWith(run: (child: FakeChild, file: string, args: readonly string[], options: unknown) => void): typeof nodeSpawn {
  return ((file: string, args: readonly string[], options: unknown) => {
    const child = new FakeChild();
    run(child, file, args, options);
    return child;
  }) as typeof nodeSpawn;
}

describe('telefony setup descriptor', () => {
  it('keeps supported fields, choices and defaults and rejects unsupported versions', () => {
    const parsed = parseTelefonySetupDescriptor({
      ...manifest(),
      fields: [...manifest().fields, { key: 'voice.future', type: 'future', default: 'x' }],
    });
    expect(parsed.setupVersion).toBe(1);
    expect(parsed.fields.map((field) => field.key)).toEqual([
      'voice.tts', 'voice.piper_model', 'voice.sapi_voice', 'voice.stt_model',
    ]);
    expect(parsed.fields[0]).toMatchObject({ type: 'enum', default: 'auto', choices: ['auto', 'piper', 'sapi', 'none'] });
    expect(parsed.fields[2].default).toBeNull();

    for (const setupVersion of [2, 1.5, '1', undefined]) {
      expect(() => parseTelefonySetupDescriptor({ setupVersion, fields: [] }))
        .toThrow(/Update telefony-app to setup version 1/);
    }
  });

  it('runs the selected executable without a shell and caches by path and mtime', async () => {
    const file = executable();
    const secondFile = executable('telefony-app-other');
    const calls: Array<{ file: string; args: readonly string[]; shell: unknown; stdio: unknown }> = [];
    let version = 'auto';
    const reader = new TelefonySetupDescriptorReader({
      spawnFn: spawnWith((child, executablePath, args, options) => {
        calls.push({
          file: executablePath,
          args,
          shell: (options as { shell: unknown }).shell,
          stdio: (options as { stdio: unknown }).stdio,
        });
        setImmediate(() => child.close(0, JSON.stringify(manifest(version))));
      }),
    });

    const first = await reader.read(file);
    expect((await reader.read(file))).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      file, args: ['describe-setup', '--json'], shell: false, stdio: ['ignore', 'pipe', 'ignore'],
    });

    version = 'piper';
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    expect((await reader.read(file)).fields[0].default).toBe('piper');
    expect((await reader.read(secondFile)).fields[0].default).toBe('piper');
    expect(calls).toHaveLength(3);
  });

  it('turns old-command failures and timeouts into an actionable update message', async () => {
    const file = executable();
    const oldBinary = new TelefonySetupDescriptorReader({
      spawnFn: spawnWith((child) => setImmediate(() => child.close(2))),
    });
    await expect(oldBinary.read(file)).rejects.toThrow(/Update telefony-app.*describe-setup --json/);

    let child: FakeChild | undefined;
    const slowBinary = new TelefonySetupDescriptorReader({
      timeoutMs: 5,
      spawnFn: spawnWith((created) => { child = created; }),
    });
    await expect(slowBinary.read(file)).rejects.toBeInstanceOf(TelefonySetupDescriptorError);
    expect(child?.killed).toBe(true);
  });
});
