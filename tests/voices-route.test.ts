import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config/timbre-config.js';
import { VoiceCatalogue } from '../src/voice/voice-catalogue.js';
import { VoicePreviewService } from '../src/voice/voice-preview.js';
import { handleVoiceRoute, matchVoiceRoute } from '../src/server/routes/voices.js';

const dirs: string[] = [];
const makeDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-voice-route-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function response() {
  const result: { status?: number; headers?: Record<string, string>; body?: Buffer } = {};
  const res = {
    writeHead(status: number, headers: Record<string, string>) { result.status = status; result.headers = headers; return this; },
    end(body?: string | Buffer) { result.body = Buffer.isBuffer(body) ? body : Buffer.from(body ?? ''); return this; },
  } as unknown as ServerResponse;
  return { result, res };
}

function fixture() {
  const dir = makeDir();
  const customDir = path.join(dir, 'custom');
  mkdirSync(customDir, { recursive: true });
  const modelPath = path.join(customDir, 'clone.onnx');
  writeFileSync(modelPath, 'model');
  writeFileSync(`${modelPath}.json`, JSON.stringify({ audio: { sample_rate: 22050 } }));
  const store = new ConfigStore(path.join(dir, 'timbre.yaml'));
  const catalogue = new VoiceCatalogue(path.join(dir, 'stock'), () => store.get().customPiperModels, async () => ['Microsoft Hazel Desktop']);
  const preview = new VoicePreviewService(catalogue, {
    piper: async () => Buffer.from('piper-wav'),
    sapi: async () => Buffer.from('sapi-wav'),
  });
  const options = { store, catalogue, preview, readJson: async () => ({}) };
  return { modelPath, options };
}

describe('voice API routes', () => {
  it('registers only valid absolute custom Piper models and returns the updated registry', async () => {
    const { modelPath, options } = fixture();
    const route = matchVoiceRoute('/api/voices/custom')!;
    const { result, res } = response();

    await handleVoiceRoute({ method: 'POST' } as IncomingMessage, res, route, { ...options, readJson: async () => ({ modelPath }) });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body!.toString())).toEqual({ customPiperModels: [path.resolve(modelPath)] });
    expect(options.store.get().customPiperModels).toEqual([path.resolve(modelPath)]);
  });

  it('returns a short audio/wav preview for a catalogue ID and rejects unknown IDs', async () => {
    const { options } = fixture();
    const voices = await options.catalogue.list();
    const id = voices.find((voice) => voice.type === 'sapi')!.id;
    const route = matchVoiceRoute('/api/voices/preview')!;
    const ok = response();

    await handleVoiceRoute({ method: 'POST' } as IncomingMessage, ok.res, route, { ...options, readJson: async () => ({ id }) });

    expect(ok.result.status).toBe(200);
    expect(ok.result.headers).toMatchObject({ 'content-type': 'audio/wav', 'cache-control': 'no-store' });
    expect(ok.result.body).toEqual(Buffer.from('sapi-wav'));

    const missing = response();
    await handleVoiceRoute({ method: 'POST' } as IncomingMessage, missing.res, route, { ...options, readJson: async () => ({ id: 'sapi:removed' }) });
    expect(missing.result.status).toBe(404);
  });

  it('supports removal and rejects unsupported methods or paths', async () => {
    const { modelPath, options } = fixture();
    const current = options.store.get();
    options.store.save({ ...current, customPiperModels: [modelPath] });
    const route = matchVoiceRoute('/api/voices/custom')!;
    const removed = response();
    await handleVoiceRoute({ method: 'DELETE' } as IncomingMessage, removed.res, route, { ...options, readJson: async () => ({ modelPath }) });

    expect(removed.result.status).toBe(200);
    expect(options.store.get().customPiperModels).toEqual([]);
    expect(matchVoiceRoute('/api/voices/other')).toBeNull();

    const method = response();
    await handleVoiceRoute({ method: 'PUT' } as IncomingMessage, method.res, route, options);
    expect(method.result.status).toBe(405);
  });
});
