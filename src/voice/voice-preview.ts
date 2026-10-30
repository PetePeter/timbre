import type { VoiceCatalogue } from './voice-catalogue.js';

export const VOICE_PREVIEW_TEXT = 'Hello. This is a short voice preview.';

export interface VoiceSynthesizers {
  piper: (modelPath: string, text: string) => Promise<Buffer>;
  sapi: (voiceName: string, text: string) => Promise<Buffer>;
}

export class VoiceNotFoundError extends Error {}

export class VoicePreviewService {
  constructor(private readonly catalogue: VoiceCatalogue, private readonly synth: VoiceSynthesizers) {}

  async synthesize(id: string): Promise<Buffer> {
    const voice = await this.catalogue.find(id);
    if (!voice) throw new VoiceNotFoundError('voice not found');
    return voice.type === 'piper'
      ? this.synth.piper(voice.modelPath, VOICE_PREVIEW_TEXT)
      : this.synth.sapi(voice.sapiVoice, VOICE_PREVIEW_TEXT);
  }
}
