import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export interface PiperPreviewOptions {
  executable?: string;
  spawn?: typeof spawn;
}

export function piperExecutable(telefonyExecutable: string, env = process.env, platform = process.platform): string | null {
  const name = platform === 'win32' ? 'piper.exe' : 'piper';
  const candidates: string[] = [];
  for (const folder of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(folder, name));
  if (telefonyExecutable) {
    const folder = path.dirname(telefonyExecutable);
    candidates.push(path.join(folder, name), path.join(folder, 'piper', name));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function synthesizePiperPreview(
  modelPath: string, text: string, telefonyExecutable: string, options: PiperPreviewOptions = {},
): Promise<Buffer> {
  const executable = options.executable ?? piperExecutable(telefonyExecutable);
  if (!executable) throw new Error('Piper executable is unavailable');
  const sidecar = JSON.parse(await fs.readFile(`${modelPath}.json`, 'utf8')) as { audio?: { sample_rate?: number } };
  const sampleRate = sidecar.audio?.sample_rate;
  if (!Number.isInteger(sampleRate) || sampleRate! < 8000 || sampleRate! > 192000) throw new Error('Piper model sample rate is invalid');
  const raw = await runPiper(executable, modelPath, text, options.spawn ?? spawn);
  if (raw.length === 0 || raw.length % 2 !== 0) throw new Error('Piper returned invalid audio');
  return pcmWav(raw, sampleRate!);
}

function runPiper(executable: string, modelPath: string, text: string, spawnProcess: typeof spawn): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, ['--model', modelPath, '--output-raw'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputSize = 0;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: Error) => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MAX_OUTPUT_BYTES) return fail(new Error('Piper preview exceeded its audio limit'));
      output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.reduce((size, part) => size + part.length, 0) < 4096) errors.push(chunk.subarray(0, 4096));
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Piper exited with code ${code}: ${Buffer.concat(errors).toString('utf8').slice(0, 300)}`));
      resolve(Buffer.concat(output, outputSize));
    });
    timer = setTimeout(() => fail(new Error('Piper preview timed out')), TIMEOUT_MS);
    child.stdin.end(`${text.replace(/[\r\n\0]/g, ' ')}\n`, 'utf8');
  });
}

function pcmWav(pcm: Buffer, sampleRate: number): Buffer {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}
