<script setup lang="ts">
import { ref, watch } from 'vue';
import { api, type CallArtifacts as CallArtifactsData, type RecordSummary } from '../api';

const props = defineProps<{ visible: boolean; phoneId: string | null; record: RecordSummary | null }>();
const artifacts = ref<CallArtifactsData | null>(null);
const loading = ref(false);
const error = ref('');
let requestVersion = 0;

watch(() => [props.visible, props.phoneId, props.record?.id, props.record?.kind] as const, async ([visible, phoneId, recordId, kind]) => {
  const version = ++requestVersion;
  artifacts.value = null;
  error.value = '';
  if (!visible || !phoneId || !recordId || kind !== 'call') return;
  loading.value = true;
  try {
    const result = await api.callArtifacts(phoneId, recordId);
    if (version === requestVersion) artifacts.value = result;
  } catch (err) {
    if (version === requestVersion) error.value = (err as Error).message;
  } finally {
    if (version === requestVersion) loading.value = false;
  }
});

function speaker(s: 'local' | 'remote'): string {
  return s === 'local' ? 'Timbre' : artifacts.value?.transcript?.contact ?? 'Caller';
}

function audioUrl(): string | undefined {
  const phoneId = props.phoneId;
  const record = props.record;
  return phoneId && record ? api.callAudioUrl(phoneId, record.id) : undefined;
}

function linkLost(): boolean {
  return !!props.record?.events.some((event) => event.type === 'call.ended' && event.details.reason === 'link_lost');
}
</script>

<template>
  <section class="call-artifacts" aria-label="Call recording and transcript">
    <h2>Recording and transcript</h2>
    <p v-if="loading" class="muted" role="status">Loading call artifacts…</p>
    <p v-else-if="error" class="error-banner" role="alert">{{ error }}</p>
    <template v-else-if="artifacts">
      <div class="audio-block">
        <p v-if="artifacts.audioAvailable && linkLost()" class="muted">Partial recording: the phone link was lost.</p>
        <audio v-if="artifacts.audioAvailable" :src="audioUrl()" controls preload="metadata" aria-label="Call audio" />
        <p v-else class="muted">No audio recording is available for this call.</p>
      </div>
      <div v-if="artifacts.summary" class="summary-block">
        <h3>Summary</h3>
        <p>{{ artifacts.summary }}</p>
      </div>
      <div class="transcript-block">
        <h3>Transcript</h3>
        <ol v-if="artifacts.transcript?.utterances.length" class="transcript-lines">
          <li v-for="(line, index) in artifacts.transcript.utterances" :key="index">
            <strong>{{ speaker(line.speaker) }}:</strong> {{ line.text }}
          </li>
        </ol>
        <p v-else class="muted">No transcript is available for this call.</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.call-artifacts { display: grid; gap: 12px; }
.call-artifacts h2 { border-bottom: 1px solid var(--line); padding-bottom: 10px; }
.call-artifacts h3 { margin-bottom: 8px; }
.audio-block audio { width: 100%; }
.transcript-lines { display: grid; gap: 10px; padding-left: 24px; line-height: 1.55; overflow-wrap: anywhere; }
.transcript-lines li { padding-left: 4px; }
</style>
