/** Telefony distinguishes speech cut off before playback from speech cut off after playback began. */
export function isSpeechInterruption(reason: string): boolean {
  return reason === 'interrupted before it played' || reason === 'interrupted during playback';
}
