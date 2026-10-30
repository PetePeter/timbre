import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VoiceCatalogue, validatePiperModelPath } from '../src/voice/voice-catalogue.js';
import { VoicePreviewService } from '../src/voice/voice-preview.js';

const dirs: string[] = [];
const makeDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-voices-'));
  dirs.push(dir);
  return dir;
};
const addModel = (dir: string, name: string) => {
  const model = path.join(dir, name);
  mkdirSync(path.dirname(model), { recursive: true });
  writeFileSync(model, 'model');
  writeFileSync(`${model}.json`, JSON.stringify({ audio: { sample_rate: 22050 } }));
  return model;
};

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('VoiceCatalogue', () => {
  it('merges stock, registered custom and injected SAPI voices and deduplicates model paths', async () => {
    const dir = makeDir();
    const stockDir = path.join(dir, 'voices');
    const stock = addModel(stockDir, 'en/test/stock.onnx');
    const custom = addModel(dir, 'custom/clone.onnx');
    const catalogue = new VoiceCatalogue(stockDir, () => [custom, stock], async () => ['Microsoft Hazel Desktop']);

    const voices = await catalogue.list();

    expect(voices.filter((voice) => voice.type === 'piper')).toHaveLength(2);
    expect(voices).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'piper', source: 'stock', modelPath: path.resolve(stock) }),
      expect.objectContaining({ type: 'piper', source: 'custom', modelPath: path.resolve(custom) }),
      expect.objectContaining({ type: 'sapi', sapiVoice: 'Microsoft Hazel Desktop' }),
      expect.objectContaining({ type: 'sapi', id: 'sapi:default', sapiVoice: '' }),
    ]));
    expect(voices.filter((voice) => voice.type === 'piper').map((voice) => voice.modelPath)).toEqual(expect.arrayContaining([path.resolve(stock), path.resolve(custom)]));
    expect(voices.filter((voice) => voice.type === 'piper' && voice.modelPath === path.resolve(stock))).toHaveLength(1);
    expect(await catalogue.find(voices.find((voice) => voice.type === 'piper')!.id)).toBeDefined();
  });

  it('creates the stock voices directory and rejects invalid custom model paths', async () => {
    const dir = makeDir();
    const missing = path.join(dir, 'missing.onnx');
    const bad = path.join(dir, 'bad.onnx');
    writeFileSync(bad, 'model');
    const catalogue = new VoiceCatalogue(path.join(dir, 'voices'), () => [], async () => []);

    await expect(catalogue.list()).resolves.toEqual([]);
    await expect(validatePiperModelPath(missing)).rejects.toThrow(/model/i);
    await expect(validatePiperModelPath(bad)).rejects.toThrow(/\.onnx\.json/i);
    await expect(validatePiperModelPath('relative.onnx')).rejects.toThrow(/absolute/i);
  });
});

describe('VoicePreviewService', () => {
  it('synthesizes the fixed preview with the selected Piper model or exact SAPI voice', async () => {
    const dir = makeDir();
    const modelPath = addModel(dir, 'voice.onnx');
    const catalogue = new VoiceCatalogue(path.join(dir, 'stock'), () => [modelPath], async () => ['Hazel']);
    const seen: Array<{ kind: string; choice: string; text: string }> = [];
    const preview = new VoicePreviewService(catalogue, {
      piper: async (model, text) => { seen.push({ kind: 'piper', choice: model, text }); return Buffer.from('piper-wav'); },
      sapi: async (voice, text) => { seen.push({ kind: 'sapi', choice: voice, text }); return Buffer.from('sapi-wav'); },
    });
    const voices = await catalogue.list();
    const piper = voices.find((voice) => voice.type === 'piper')!;
    const sapi = voices.find((voice) => voice.type === 'sapi' && voice.sapiVoice === 'Hazel')!;
    const sapiDefault = voices.find((voice) => voice.type === 'sapi' && !voice.sapiVoice)!;

    await expect(preview.synthesize(piper.id)).resolves.toEqual(Buffer.from('piper-wav'));
    await expect(preview.synthesize(sapi.id)).resolves.toEqual(Buffer.from('sapi-wav'));
    await expect(preview.synthesize(sapiDefault.id)).resolves.toEqual(Buffer.from('sapi-wav'));
    expect(seen.map(({ kind, choice }) => ({ kind, choice }))).toEqual([
      { kind: 'piper', choice: path.resolve(modelPath) },
      { kind: 'sapi', choice: 'Hazel' },
      { kind: 'sapi', choice: '' },
    ]);
    expect(seen[0].text).toBe(seen[1].text);
    expect(seen[0].text.length).toBeLessThan(200);
  });
});
