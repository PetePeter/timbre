import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const SUPPORTED_SETUP_VERSION = 1;
const DESCRIBE_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const FIELD_TYPES = new Set(['enum', 'path', 'string']);
const FIELD_KEYS: Record<string, string> = {
  'voice.tts': 'enum',
  'voice.piper_model': 'path',
  'voice.sapi_voice': 'string',
  'voice.stt_model': 'string',
  'voice.whisper_cpp_server': 'path',
  'voice.whisper_cpp_model': 'path',
};

export type TelefonySetupFieldType = 'enum' | 'path' | 'string';
export interface TelefonySetupField {
  key: string;
  label: string;
  type: TelefonySetupFieldType;
  default: string | number | boolean | null;
  choices?: string[];
  restartRequired?: boolean;
  help?: string;
}

export interface TelefonySetupDescriptor {
  provider?: string;
  providerVersion?: string;
  setupVersion: 1;
  fields: TelefonySetupField[];
}

export class TelefonySetupDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelefonySetupDescriptorError';
  }
}

interface CacheEntry { mtimeMs: number; descriptor: TelefonySetupDescriptor }
interface DescriptorReaderOptions {
  spawnFn?: typeof spawn;
  timeoutMs?: number;
}

/** Reads the operator-safe setup manifest from the selected shared executable. */
export class TelefonySetupDescriptorReader {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly spawnFn: typeof spawn;
  private readonly timeoutMs: number;

  constructor(options: DescriptorReaderOptions = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
    this.timeoutMs = options.timeoutMs ?? DESCRIBE_TIMEOUT_MS;
  }

  async read(executable: string): Promise<TelefonySetupDescriptor> {
    const selected = executable.trim();
    if (!selected) {
      throw new TelefonySetupDescriptorError('Choose the shared telefony-app executable in Settings to load provider setup.');
    }

    const file = path.resolve(selected);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      throw new TelefonySetupDescriptorError('The shared telefony-app executable is unavailable. Check its path in Settings.');
    }

    const cacheKey = process.platform === 'win32' ? file.toLowerCase() : file;
    const cached = this.cache.get(cacheKey);
    if (cached?.mtimeMs === info.mtimeMs) return cached.descriptor;

    const descriptor = await this.describe(file);
    this.cache.set(cacheKey, { mtimeMs: info.mtimeMs, descriptor });
    return descriptor;
  }

  private describe(executable: string): Promise<TelefonySetupDescriptor> {
    return new Promise((resolve, reject) => {
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let child: ChildProcess;

      const finish = (error?: Error, descriptor?: TelefonySetupDescriptor) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (error) reject(error);
        else resolve(descriptor!);
      };

      try {
        child = this.spawnFn(executable, ['describe-setup', '--json'], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        finish(updateRequiredError('could not start'));
        return;
      }

      const collect = (current: Buffer<ArrayBufferLike>, chunk: Buffer | string): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (next.byteLength > MAX_OUTPUT_BYTES) {
          child.kill();
          finish(updateRequiredError('returned too much data'));
          return current;
        }
        return next;
      };

      child.stdout?.on('data', (chunk: Buffer | string) => { stdout = collect(stdout, chunk); });
      child.once('error', () => finish(updateRequiredError('could not run the setup descriptor command')));
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(updateRequiredError('does not support the setup descriptor command'));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout.toString('utf8'));
          finish(undefined, parseTelefonySetupDescriptor(parsed));
        } catch (error) {
          finish(error instanceof TelefonySetupDescriptorError ? error : updateRequiredError('returned invalid JSON'));
        }
      });

      timeout = setTimeout(() => {
        child.kill();
        finish(updateRequiredError('timed out while describing setup'));
      }, this.timeoutMs);
      timeout.unref?.();
    });
  }
}

export function parseTelefonySetupDescriptor(value: unknown): TelefonySetupDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw updateRequiredError('returned an invalid setup descriptor');
  }
  const raw = value as Record<string, unknown>;
  const version = raw.setupVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version !== SUPPORTED_SETUP_VERSION) {
    const shown = typeof version === 'number' || typeof version === 'string' ? String(version) : 'missing';
    throw new TelefonySetupDescriptorError(
      `telefony-app setup descriptor version ${shown} is not supported. Update telefony-app to setup version ${SUPPORTED_SETUP_VERSION}.`,
    );
  }
  if (!Array.isArray(raw.fields)) throw updateRequiredError('returned an invalid setup descriptor');

  const seen = new Set<string>();
  const fields: TelefonySetupField[] = [];
  for (const item of raw.fields) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const field = item as Record<string, unknown>;
    if (typeof field.key !== 'string' || seen.has(field.key) || !FIELD_TYPES.has(String(field.type))) continue;
    if (FIELD_KEYS[field.key] !== field.type) continue;
    if (field.default !== null && !['string', 'number', 'boolean'].includes(typeof field.default)) continue;

    seen.add(field.key);
    const choices = Array.isArray(field.choices)
      ? field.choices.filter((choice): choice is string => typeof choice === 'string')
      : undefined;
    fields.push({
      key: field.key,
      label: typeof field.label === 'string' ? field.label : field.key,
      type: field.type as TelefonySetupFieldType,
      default: field.default as TelefonySetupField['default'],
      ...(choices?.length ? { choices } : {}),
      ...(typeof field.restartRequired === 'boolean' ? { restartRequired: field.restartRequired } : {}),
      ...(typeof field.help === 'string' ? { help: field.help } : {}),
    });
  }

  return {
    ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}),
    ...(typeof raw.providerVersion === 'string' ? { providerVersion: raw.providerVersion } : {}),
    setupVersion: SUPPORTED_SETUP_VERSION,
    fields,
  };
}

function updateRequiredError(reason: string): TelefonySetupDescriptorError {
  return new TelefonySetupDescriptorError(
    `telefony-app ${reason}. Update telefony-app to a build that supports describe-setup --json.`,
  );
}
