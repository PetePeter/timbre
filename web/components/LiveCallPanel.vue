<script setup lang="ts">
import { computed, ref } from 'vue';
import Button from 'primevue/button';
import { useAppState } from '../app-state';
import TestCallDialog from './TestCallDialog.vue';
import { useLiveCall } from '../use-live-call';
const state = useAppState();
const call = computed(() => state.selectedStatus?.line.line?.call);
const testCallVisible = ref(false);
const connected = computed(() => state.selectedStatus?.line.line?.connected ?? false);
const liveAudioAvailable = computed(() => state.selectedStatus?.line.line?.liveAudioAvailable ?? false);
const { snapshot, listening, busyTakeover, error, takeoverMessage, startListening, stopListening, takeover } =
  useLiveCall(computed(() => state.selectedPhone?.id ?? null), computed(() => call.value?.callId ?? null));
</script>
<template>
  <section class="panel live-panel" :class="{ 'on-call': call }">
    <div class="section-heading"><h2>On the line</h2><span class="pill" :class="call ? 'rose' : 'green'">● {{ call ? 'Live' : 'Quiet' }}</span></div>
    <div class="live-illustration" aria-hidden="true"><span>☎</span><i /><i /><i /><i /><i /></div>
    <h3>{{ call?.label || 'A moment of quiet' }}</h3><p class="muted">{{ call ? `Your phone is ${call.state}.` : 'When a call comes in, you’ll find it here.' }}</p>
    <div class="row live-actions">
      <Button label="Test call" severity="secondary" outlined :disabled="!state.selectedPhone || !connected || !!call" @click="testCallVisible = true" />
      <Button :label="listening ? 'Stop listening' : 'Listen'" severity="secondary" :disabled="!call || call.state !== 'active' || !connected || !liveAudioAvailable" @click="listening ? stopListening() : startListening()" />
      <Button label="Take over" severity="secondary" :disabled="!call || call.state !== 'active' || !connected || busyTakeover" :loading="busyTakeover" @click="takeover" />
    </div>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <p v-else-if="takeoverMessage" class="muted" role="status">{{ takeoverMessage }}</p>
    <ol v-if="snapshot" class="live-transcript" aria-live="polite" aria-label="Live call transcript">
      <li v-if="!snapshot.utterances.length" class="muted">Waiting for speech…</li>
      <li v-for="(utterance, index) in snapshot.utterances" :key="`${utterance.startMs}-${index}`">
        <strong>{{ utterance.speaker === 'remote' ? snapshot.label : 'Timbre' }}:</strong> {{ utterance.text }}
      </li>
    </ol>
    <TestCallDialog v-model:visible="testCallVisible" :phone-id="state.selectedPhone?.id ?? null" :phone-name="state.selectedPhone?.name ?? 'Phone'" />
  </section>
</template>

<style scoped>
.live-transcript { display: grid; gap: .55rem; list-style: none; margin: 1rem 0 0; max-height: 16rem; overflow-y: auto; padding: 0; }
.live-transcript li { line-height: 1.45; overflow-wrap: anywhere; }
</style>
