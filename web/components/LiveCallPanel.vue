<script setup lang="ts">
import { computed, ref } from 'vue';
import Button from 'primevue/button';
import { useAppState } from '../app-state';
import TestCallDialog from './TestCallDialog.vue';
const state = useAppState();
const call = computed(() => state.selectedStatus?.line.line?.call);
const testCallVisible = ref(false);
const connected = computed(() => state.selectedStatus?.line.line?.connected ?? false);
</script>
<template>
  <section class="panel live-panel" :class="{ 'on-call': call }">
    <div class="section-heading"><h2>On the line</h2><span class="pill" :class="call ? 'rose' : 'green'">● {{ call ? 'Live' : 'Quiet' }}</span></div>
    <div class="live-illustration" aria-hidden="true"><span>☎</span><i /><i /><i /><i /><i /></div>
    <h3>{{ call?.label || 'A moment of quiet' }}</h3><p class="muted">{{ call ? `Your phone is ${call.state}.` : 'When a call comes in, you’ll find it here.' }}</p>
    <div class="row live-actions">
      <Button label="Test call" severity="secondary" outlined :disabled="!state.selectedPhone || !connected || !!call" @click="testCallVisible = true" />
      <Button label="Listen" severity="secondary" disabled title="Listening is not available yet" /><Button label="Take over" severity="secondary" disabled title="Takeover is not available yet" />
    </div>
    <TestCallDialog v-model:visible="testCallVisible" :phone-id="state.selectedPhone?.id ?? null" :phone-name="state.selectedPhone?.name ?? 'Phone'" />
  </section>
</template>
