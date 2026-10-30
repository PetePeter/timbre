import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { synthesizePiperPreview } from '../src/voice/piper-preview.js';
import { synthesizeSapiPreview } from '../src/voice/sapi-preview.js';

let root: string;
let stubPath: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'timbre-preview-adapter-test-'));
  stubPath = path.join(root, 'process-stub.cjs');
  writeFileSync(stubPath, `
const fs = require('node:fs');
const [mode, ...args] = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString('utf8');
  fs.writeFileSync(process.env.STUB_CAPTURE, JSON.stringify({ args, input }));
  if (mode === 'piper') {
    process.stdout.write(Buffer.from([1, 0, 2, 0]));
    return;
  }
  if (mode === 'sapi-failure') {
    process.stderr.write('forced SAPI failure');
    process.exitCode = 7;
    return;
  }
  const request = JSON.parse(input);
  fs.writeFileSync(request.path, Buffer.from('stub wav'));
});
`);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function spawnWithStub(mode: string, capturePath: string): typeof spawn {
  return ((_: string, args: readonly string[], options: SpawnOptions) => spawn(
    process.execPath,
    [stubPath, mode, ...args],
    { ...options, env: { ...process.env, ...options.env, STUB_CAPTURE: capturePath } },
  )) as typeof spawn;
}

function readCapture(file: string): { args: string[]; input: string } {
  return JSON.parse(readFileSync(file, 'utf8')) as { args: string[]; input: string };
}

describe('preview process adapters', () => {
  it('passes Piper model and preview text as process data', async () => {
    const modelPath = path.join(root, 'model & voice.onnx');
    writeFileSync(modelPath, 'model');
    writeFileSync(`${modelPath}.json`, JSON.stringify({ audio: { sample_rate: 22050 } }));
    const capturePath = path.join(root, 'piper-capture.json');
    const text = 'Say "hello"; $env:PATH\nnext line';

    const wav = await synthesizePiperPreview(modelPath, text, [], {
      executable: 'piper-stub',
      spawn: spawnWithStub('piper', capturePath),
    });

    const capture = readCapture(capturePath);
    expect(capture.args).toEqual(['--model', modelPath, '--output-raw']);
    expect(capture.input).toBe('Say "hello"; $env:PATH next line\n');
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
  });

  it('passes SAPI voice and preview text as JSON data and removes temporary output after success', async () => {
    const capturePath = path.join(root, 'sapi-success-capture.json');
    const voice = 'Hazel"; Write-Output injected';
    const text = 'Hello "world"; $env:TEMP';
    const wav = await synthesizeSapiPreview(voice, text, 'win32', {
      spawn: spawnWithStub('sapi-success', capturePath),
    });

    const capture = readCapture(capturePath);
    const script = capture.args[3];
    const request = JSON.parse(capture.input) as { voice: string; text: string; path: string };
    expect(script).toContain('ConvertFrom-Json');
    expect(script).not.toContain(voice);
    expect(script).not.toContain(text);
    expect(request).toMatchObject({ voice, text });
    expect(path.basename(request.path)).toBe('preview.wav');
    expect(existsSync(path.dirname(request.path))).toBe(false);
    expect(wav).toEqual(Buffer.from('stub wav'));
  });

  it('removes the SAPI temporary output directory after process failure', async () => {
    const capturePath = path.join(root, 'sapi-failure-capture.json');
    await expect(synthesizeSapiPreview('Hazel', 'hello', 'win32', {
      spawn: spawnWithStub('sapi-failure', capturePath),
    })).rejects.toThrow(/exited with code 7/);

    const capture = readCapture(capturePath);
    const request = JSON.parse(capture.input) as { path: string };
    expect(existsSync(path.dirname(request.path))).toBe(false);
  });
});
