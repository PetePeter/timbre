import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 30_000;

export interface SapiPreviewOptions {
  spawn?: typeof spawn;
}

export async function listSapiVoices(platform = process.platform): Promise<string[]> {
  if (platform !== 'win32') return [];
  const script = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $v = @($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }); ConvertTo-Json -InputObject $v -Compress; $s.Dispose()";
  const output = await runPowerShell(script);
  const parsed: unknown = JSON.parse(output.toString('utf8') || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((voice): voice is string => typeof voice === 'string');
}

export async function synthesizeSapiPreview(
  voiceName: string, text: string, platform = process.platform, options: SapiPreviewOptions = {},
): Promise<Buffer> {
  if (platform !== 'win32') throw new Error('Windows SAPI is unavailable');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'timbre-sapi-preview-'));
  const wavPath = path.join(directory, 'preview.wav');
  const input = JSON.stringify({ voice: voiceName, text, path: wavPath });
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$r = ConvertFrom-Json ([Console]::In.ReadToEnd())',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'try { if (-not [string]::IsNullOrWhiteSpace([string]$r.voice)) { $s.SelectVoice([string]$r.voice) }; $s.SetOutputToWaveFile([string]$r.path); $s.Speak([string]$r.text) }',
    'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
    'finally { $s.Dispose() }',
  ].join('; ');
  try {
    await runPowerShell(script, input, options.spawn ?? spawn);
    return await readFile(wavPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runPowerShell(script: string, input = '', spawnProcess: typeof spawn = spawn): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? 'powershell.exe' : 'powershell';
    const child = spawnProcess(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout>;
    let size = 0;
    const fail = (error: Error) => { clearTimeout(timer); child.kill(); reject(error); };
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) return fail(new Error('PowerShell output exceeded its limit'));
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8) stderr.push(chunk.subarray(0, 4096)); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`System.Speech exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`));
      resolve(Buffer.concat(stdout, size));
    });
    timer = setTimeout(() => fail(new Error('System.Speech preview timed out')), TIMEOUT_MS);
    child.stdin.end(input, 'utf8');
  });
}
