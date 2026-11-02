export function centerMonoPlayback(audio: HTMLMediaElement): () => void {
  const AudioContextConstructor = globalThis.AudioContext;
  if (!AudioContextConstructor) return () => {};

  let context: AudioContext | undefined;
  let source: MediaElementAudioSourceNode | undefined;
  let mono: GainNode | undefined;
  let output: ChannelMergerNode | undefined;

  const resume = () => {
    if (context?.state === 'suspended') void context.resume().catch(() => {});
  };

  try {
    context = new AudioContextConstructor();
    source = context.createMediaElementSource(audio);
    mono = context.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    output = context.createChannelMerger(2);

    source.connect(mono);
    mono.connect(output, 0, 0);
    mono.connect(output, 0, 1);
    output.connect(context.destination);
  } catch {
    if (!source || !context) {
      if (context) void context.close().catch(() => {});
      return () => {};
    }

    try {
      source.disconnect();
      mono?.disconnect();
      output?.disconnect();
      source.connect(context.destination);
    } catch {
      // Keep playback routed through the context if stereo reconnection also fails.
    }
  }

  audio.addEventListener('play', resume);
  return () => {
    audio.removeEventListener('play', resume);
    source?.disconnect();
    mono?.disconnect();
    output?.disconnect();
    if (context?.state !== 'closed') void context?.close().catch(() => {});
  };
}
