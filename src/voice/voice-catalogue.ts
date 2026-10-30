import { existsSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type PiperVoiceChoice = {
  id: string;
  type: 'piper';
  source: 'stock' | 'custom';
  label: string;
  modelPath: string;
};

export type SapiVoiceChoice = {
  id: string;
  type: 'sapi';
  source: 'sapi';
  label: string;
  sapiVoice: string;
};

export type VoiceChoice = PiperVoiceChoice | SapiVoiceChoice;

export class VoiceCatalogue {
  constructor(
    private readonly stockDir: string,
    private readonly customModelPaths: () => readonly string[],
    private readonly listSapiVoices: () => Promise<string[]>,
  ) {
    mkdirSync(stockDir, { recursive: true });
  }

  async list(): Promise<VoiceChoice[]> {
    const choices = new Map<string, VoiceChoice>();
    for (const modelPath of await findModels(this.stockDir)) {
      const choice = piperChoice(modelPath, 'stock');
      choices.set(pathKey(choice.modelPath), choice);
    }
    for (const modelPath of this.customModelPaths()) {
      try {
        const absolutePath = await validatePiperModelPath(modelPath);
        const key = pathKey(absolutePath);
        if (!choices.has(key)) choices.set(key, piperChoice(absolutePath, 'custom'));
      } catch {
        // A removed or broken custom model stays registered but is not selectable.
      }
    }

    let names: string[] = [];
    try { names = await this.listSapiVoices(); } catch { /* SAPI is optional. */ }
    const sapiNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    return [
      ...choices.values(),
      ...(sapiNames.length ? [{ id: 'sapi:default', type: 'sapi' as const, source: 'sapi' as const, label: 'Windows SAPI default', sapiVoice: '' }] : []),
      ...sapiNames.map<SapiVoiceChoice>((name) => ({ id: `sapi:${encodeURIComponent(name)}`, type: 'sapi', source: 'sapi', label: name, sapiVoice: name })),
    ];
  }

  async find(id: string): Promise<VoiceChoice | undefined> {
    return (await this.list()).find((voice) => voice.id === id);
  }
}

export async function validatePiperModelPath(value: string): Promise<string> {
  const modelPath = typeof value === 'string' ? value.trim() : '';
  if (!modelPath || !path.isAbsolute(modelPath)) throw new Error('Piper model path must be absolute');
  if (path.extname(modelPath).toLowerCase() !== '.onnx') throw new Error('Piper model must be an .onnx file');
  const absolutePath = path.resolve(modelPath);
  const model = await fs.stat(absolutePath).catch(() => null);
  if (!model?.isFile()) throw new Error('Piper model file does not exist');
  const sidecarPath = `${absolutePath}.json`;
  const sidecar = await fs.stat(sidecarPath).catch(() => null);
  if (!sidecar?.isFile()) throw new Error('Piper model needs its adjacent .onnx.json file');
  try {
    JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  } catch {
    throw new Error('Piper model .onnx.json file is invalid');
  }
  return absolutePath;
}

async function findModels(directory: string): Promise<string[]> {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  const models: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) models.push(...await findModels(fullPath));
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.onnx') {
      try { models.push(await validatePiperModelPath(fullPath)); } catch { /* Ignore incomplete stock downloads. */ }
    }
  }
  return models;
}

function piperChoice(modelPath: string, source: PiperVoiceChoice['source']): PiperVoiceChoice {
  return {
    id: `piper:${Buffer.from(pathKey(modelPath)).toString('base64url')}`,
    type: 'piper', source, modelPath,
    label: path.basename(modelPath),
  };
}

function pathKey(modelPath: string): string {
  const normalized = path.normalize(path.resolve(modelPath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
