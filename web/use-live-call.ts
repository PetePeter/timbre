import { onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import { api, type LiveAudioFrame, type LiveCallEvent, type LiveCallSnapshot } from './api';

const MAX_UTTERANCES = 200;

export function useLiveCall(phoneId: Ref<string | null>, callId: ComputedRef<string | null>) {
  const snapshot = ref<LiveCallSnapshot | null>(null);
  const listening = ref(false);
  const busyTakeover = ref(false);
  const error = ref('');
  const takeoverMessage = ref('');
  let callEvents: EventSource | null = null;
  let audioEvents: EventSource | null = null;
  let audioContext: AudioContext | null = null;
  let nextAudioTime = 0;
  let lastSequence = -1;
  let generation = 0;
  let audioGeneration = 0;

  function closeCallEvents(): void {
    callEvents?.close();
    callEvents = null;
  }

  function stopListening(): void {
    audioGeneration++;
    audioEvents?.close();
    audioEvents = null;
    listening.value = false;
    nextAudioTime = 0;
    lastSequence = -1;
    const context = audioContext;
    audioContext = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }

  function receiveCallEvent(event: LiveCallEvent): void {
    const current = snapshot.value;
    if (!current || event.callId !== current.callId) return;
    if (event.type === 'utterance') {
      snapshot.value = { ...current, utterances: [...current.utterances, event.utterance].slice(-MAX_UTTERANCES) };
      return;
    }
    snapshot.value = { ...current, state: event.state };
    if (event.state === 'ended') {
      stopListening();
      closeCallEvents();
    }
  }

  function openCallEvents(id: string, call: string): void {
    const source = new EventSource(api.liveCallEventsUrl(id, call));
    callEvents = source;
    source.addEventListener('snapshot', (raw) => {
      const next = JSON.parse((raw as MessageEvent<string>).data) as LiveCallSnapshot;
      if (next.callId === call) snapshot.value = next;
    });
    source.addEventListener('utterance', (raw) => receiveCallEvent(JSON.parse((raw as MessageEvent<string>).data) as LiveCallEvent));
    source.addEventListener('state', (raw) => receiveCallEvent(JSON.parse((raw as MessageEvent<string>).data) as LiveCallEvent));
    source.onerror = () => {
      if (callEvents !== source) return;
      error.value = 'Live call updates disconnected.';
      closeCallEvents();
    };
  }

  function playFrame(frame: LiveAudioFrame): void {
    const context = audioContext;
    if (!context || frame.sequence <= lastSequence || frame.sampleRate !== 8000 || frame.channels !== 2
      || frame.encoding !== 'pcm_s16le' || frame.data.length !== 856) return;
    lastSequence = frame.sequence;
    const binary = atob(frame.data);
    if (binary.length !== 640) return;
    const buffer = context.createBuffer(2, 160, 8000);
    const view = new DataView(Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let sample = 0; sample < 160; sample++) {
      left[sample] = view.getInt16(sample * 4, true) / 32768;
      right[sample] = view.getInt16(sample * 4 + 2, true) / 32768;
    }

    const now = context.currentTime;
    if (nextAudioTime === 0) nextAudioTime = now + 0.04;
    else if (nextAudioTime < now) nextAudioTime = now + 0.02;
    if (nextAudioTime - now > 0.16) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(nextAudioTime);
    nextAudioTime += buffer.duration;
  }

  async function startListening(): Promise<void> {
    const id = phoneId.value;
    const call = callId.value;
    if (!id || !call || listening.value) return;
    const requestGeneration = ++audioGeneration;
    error.value = '';
    try {
      const context = new AudioContext();
      audioContext = context;
      await context.resume();
      if (requestGeneration !== audioGeneration || audioContext !== context) {
        if (context.state !== 'closed') void context.close().catch(() => undefined);
        return;
      }
      const source = new EventSource(api.liveCallAudioUrl(id, call));
      audioEvents = source;
      source.addEventListener('frame', (raw) => {
        try { playFrame(JSON.parse((raw as MessageEvent<string>).data) as LiveAudioFrame); }
        catch { error.value = 'Received an invalid audio frame.'; }
      });
      source.addEventListener('ended', stopListening);
      source.onerror = () => {
        if (audioEvents !== source) return;
        error.value = 'Live audio disconnected.';
        stopListening();
      };
      listening.value = true;
    } catch (err) {
      if (requestGeneration !== audioGeneration) return;
      error.value = (err as Error).message || 'Could not start live audio.';
      stopListening();
    }
  }

  async function takeover(): Promise<void> {
    const id = phoneId.value;
    const call = callId.value;
    if (!id || !call || busyTakeover.value) return;
    const requestGeneration = generation;
    busyTakeover.value = true;
    error.value = '';
    takeoverMessage.value = '';
    try {
      await api.takeoverLiveCall(id, call);
      if (requestGeneration === generation) takeoverMessage.value = 'Owner connected to the call.';
    } catch (err) {
      if (requestGeneration === generation) error.value = (err as Error).message;
    } finally {
      if (requestGeneration === generation) busyTakeover.value = false;
    }
  }

  watch([phoneId, callId], ([id, call]) => {
    generation++;
    closeCallEvents();
    stopListening();
    snapshot.value = null;
    error.value = '';
    takeoverMessage.value = '';
    busyTakeover.value = false;
    if (!id || !call) return;
    try { openCallEvents(id, call); }
    catch (err) { error.value = (err as Error).message || 'Could not open live call updates.'; }
  }, { immediate: true });

  onBeforeUnmount(() => {
    generation++;
    closeCallEvents();
    stopListening();
  });

  return { snapshot, listening, busyTakeover, error, takeoverMessage, startListening, stopListening, takeover };
}
