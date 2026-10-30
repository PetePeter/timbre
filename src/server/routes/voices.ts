import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { ConfigStore } from '../../config/timbre-config.js';
import { VoiceCatalogue, validatePiperModelPath } from '../../voice/voice-catalogue.js';
import { VoiceNotFoundError, VoicePreviewService } from '../../voice/voice-preview.js';

export type VoiceRoute = { action: 'catalogue' | 'custom-model' | 'preview' };

export interface VoiceRouteOptions {
  store: ConfigStore;
  catalogue: VoiceCatalogue;
  preview: VoicePreviewService;
  readJson: (req: IncomingMessage) => Promise<unknown>;
}

export function matchVoiceRoute(pathname: string): VoiceRoute | null {
  if (pathname === '/api/voices') return { action: 'catalogue' };
  if (pathname === '/api/voices/custom') return { action: 'custom-model' };
  if (pathname === '/api/voices/preview') return { action: 'preview' };
  return null;
}

export async function handleVoiceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: VoiceRoute,
  options: VoiceRouteOptions,
): Promise<boolean> {
  if (route.action === 'catalogue') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    return json(res, 200, await options.catalogue.list());
  }
  if (route.action === 'preview') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const body = await options.readJson(req) as { id?: unknown };
    if (typeof body.id !== 'string' || !body.id) return json(res, 400, { error: 'voice id is required' });
    try {
      const audio = await options.preview.synthesize(body.id);
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length, 'cache-control': 'no-store' });
      res.end(audio);
      return true;
    } catch (error) {
      if (error instanceof VoiceNotFoundError) return json(res, 404, { error: error.message });
      return json(res, 503, { error: 'voice preview is unavailable' });
    }
  }

  if (req.method !== 'POST' && req.method !== 'DELETE') return json(res, 405, { error: 'method not allowed' });
  const body = await options.readJson(req) as { modelPath?: unknown };
  if (typeof body.modelPath !== 'string') return json(res, 400, { error: 'absolute modelPath is required' });
  const current = options.store.get();
  if (req.method === 'POST') {
    let modelPath: string;
    try { modelPath = await validatePiperModelPath(body.modelPath); }
    catch (error) { return json(res, 400, { error: (error as Error).message }); }
    const customPiperModels = [...current.customPiperModels, modelPath];
    const saved = options.store.save({ ...current, customPiperModels });
    return json(res, 200, { customPiperModels: saved.customPiperModels });
  }

  const modelPath = path.resolve(body.modelPath);
  const key = pathKey(modelPath);
  if (current.phones.some((phone) => phone.line.voice.tts === 'piper' && phone.line.voice.piperModel && pathKey(path.resolve(phone.line.voice.piperModel)) === key)) {
    return json(res, 409, { error: 'Piper model is selected by a phone; change and save that phone first' });
  }
  const customPiperModels = current.customPiperModels.filter((candidate) => pathKey(candidate) !== key);
  const saved = options.store.save({ ...current, customPiperModels });
  return json(res, 200, { customPiperModels: saved.customPiperModels });
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

function pathKey(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
