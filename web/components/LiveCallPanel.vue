<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import Button from 'primevue/button';
import { useAppState } from '../app-state';
import { useLiveCall } from '../use-live-call';
const state = useAppState();
const call = computed(() => state.selectedStatus?.line.line?.call);
const connected = computed(() => state.selectedStatus?.line.line?.connected ?? false);
const liveAudioAvailable = computed(() => state.selectedStatus?.line.line?.liveAudioAvailable ?? false);
const { snapshot, listening, busyTakeover, busyHangup, error, takeoverMessage, startListening, stopListening, takeover, hangup } =
  useLiveCall(computed(() => state.selectedPhone?.id ?? null), computed(() => call.value?.callId ?? null));
</script>
<template>
  <section class="panel live-panel" :class="{ 'on-call': call }">
    <div class="section-heading"><h2>On the line</h2><span class="pill" :class="call ? 'rose' : 'green'">{{ call ? '● Live' : state.selectedPhone ? '● Quiet' : 'No phone' }}</span></div>
    <div class="live-illustration" aria-hidden="true"><span>☎</span><i /><i /><i /><i /><i /></div>
    <h3>{{ !state.selectedPhone ? 'No phone configured' : call?.label || 'A moment of quiet' }}</h3>
    <p class="muted">{{ !state.selectedPhone ? 'Set up a phone before using live call controls.' : call ? `Your phone is ${call.state}.` : 'When a call comes in, you’ll find it here.' }}</p>
    <RouterLink v-if="!state.selectedPhone" :to="{ path: '/phones', query: { setup: '1' } }">Set up a phone</RouterLink>
    <div class="row live-actions">
      <Button :label="listening ? 'Stop listening' : 'Listen'" severity="secondary" :disabled="!call || call.state !== 'active' || !connected || !liveAudioAvailable" @click="listening ? stopListening() : startListening()" />
      <Button label="Take over" severity="secondary" :disabled="!call || call.state !== 'active' || !connected || busyTakeover" :loading="busyTakeover" @click="takeover" />
      <Button label="Hang up" severity="danger" :disabled="!call?.callId || call.state === 'ended' || !connected || busyHangup" :loading="busyHangup" @click="hangup" />
    </div>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <p v-else-if="takeoverMessage" class="muted" role="status">{{ takeoverMessage }}</p>
    <ol v-if="snapshot" class="live-transcript" aria-live="polite" aria-label="Live call transcript">
      <li v-if="!snapshot.utterances.length" class="muted">Waiting for speech…</li>
      <li v-for="(utterance, index) in snapshot.utterances" :key="`${utterance.startMs}-${index}`">
        <strong>{{ utterance.speaker === 'remote' ? snapshot.label : 'Timbre' }}:</strong> {{ utterance.text }}
      </li>
    </ol>
  </section>
</template>

<style scoped>
.live-transcript { display: grid; gap: .55rem; list-style: none; margin: 1rem 0 0; max-height: 16rem; overflow-y: auto; padding: 0; }
.live-transcript li { line-height: 1.45; overflow-wrap: anywhere; }
</style>
