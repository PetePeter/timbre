<script setup lang="ts">
import SelectButton from 'primevue/selectbutton';
import { useAppState } from '../app-state';
const state = useAppState();
</script>
<template>
  <section class="panel quick-controls"><div class="section-heading"><h2>Quick controls</h2><span class="pill sample-label">Preview</span></div>
    <div class="quick-control"><span>Mode</span><SelectButton model-value="Normal" :options="['Normal', 'Busy', 'DND']" disabled aria-label="Mode preview" /></div>
    <div class="quick-control"><span>Unknown callers</span><SelectButton model-value="Screen" :options="['Allow', 'Screen', 'Block']" disabled aria-label="Unknown callers preview" /></div>
    <div class="quick-control"><span>Private numbers</span><SelectButton model-value="Block" :options="['Allow', 'Block']" disabled aria-label="Private numbers preview" /></div>
    <div class="control-row"><span>Agent</span><span class="pill sky">{{ state.cfg?.llms.find((llm) => llm.id === state.selectedPhone?.llmId)?.name || 'Not set' }}</span></div>
    <p class="muted small">Sample spend today: 32k of 100k tokens.</p>
  </section>
</template>
