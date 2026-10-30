<script setup lang="ts">
import { ref, watch } from 'vue';
import Button from 'primevue/button';
import InsightsOutcomeChart from '../components/InsightsOutcomeChart.vue';
import InsightsTable from '../components/InsightsTable.vue';
import { api } from '../api';
import { useAppState } from '../app-state';
import { localDateRangeToUtc } from '../record-date-range';
import type { CallAnalytics } from '../../src/records/analytics.js';

const state = useAppState();
const today = localDateString(new Date());
const fromDate = ref(today);
const toDate = ref(today);
const analytics = ref<CallAnalytics | null>(null);
const loading = ref(false);
const error = ref('');
let loadSequence = 0;

watch(() => state.selectedPhone?.id, () => { void load(); }, { immediate: true });

async function load(): Promise<void> {
  const phoneId = state.selectedPhone?.id;
  const sequence = ++loadSequence;
  analytics.value = null;
  error.value = '';
  if (!phoneId) return;
  loading.value = true;
  try {
    const range = localDateRangeToUtc(fromDate.value, toDate.value);
    const result = await api.insights(phoneId, range);
    if (sequence === loadSequence && state.selectedPhone?.id === phoneId) analytics.value = result;
  } catch (err) {
    if (sequence === loadSequence) error.value = (err as Error).message;
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

function localDateString(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  return minutes ? `${minutes}m ${rounded % 60}s` : `${rounded}s`;
}

function percent(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}
</script>

<template>
  <div class="page-heading">
    <div><h1>Insights</h1><p>Call outcomes and handovers for {{ state.selectedPhone?.name ?? 'your phone' }}.</p></div>
  </div>

  <section class="panel insights-panel" aria-label="Call insights">
    <form class="date-filters" @submit.prevent="load">
      <label class="field"><span>From</span><input v-model="fromDate" type="date" aria-label="Start date" /></label>
      <label class="field"><span>To</span><input v-model="toDate" type="date" aria-label="End date" /></label>
      <Button label="Apply" :disabled="loading || !state.selectedPhone" :loading="loading" />
    </form>

    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="muted" role="status">Loading call insights…</p>
    <template v-else-if="analytics">
      <p v-if="analytics.totalCalls === 0" class="muted" role="status">No calls in this date range.</p>
      <section class="insights-section" aria-labelledby="outcome-heading">
        <h2 id="outcome-heading">Outcome mix</h2>
        <InsightsOutcomeChart :outcomes="analytics.outcomes" />
      </section>
      <section class="insights-section" aria-labelledby="outcome-table-heading">
        <h2 id="outcome-table-heading">Call outcomes</h2>
        <InsightsTable :outcomes="analytics.outcomes" />
        <p class="muted overall-duration">Average call length: {{ duration(analytics.averageDurationSeconds) }}</p>
      </section>
      <p class="handover-summary">
        <strong>Handover to conference:</strong>
        <template v-if="analytics.handovers.rate === null">No handovers recorded in this date range.</template>
        <template v-else>{{ analytics.handovers.successes }} of {{ analytics.handovers.attempts }} handovers ({{ percent(analytics.handovers.rate) }}).</template>
      </p>
    </template>
  </section>
</template>

<style scoped>
.insights-panel { display: grid; gap: 22px; }
.date-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
.date-filters .field { min-width: 160px; }
.date-filters input { min-height: 42px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text); padding: 8px 10px; }
.insights-section { display: grid; gap: 12px; }
.insights-section h2 { margin: 0; font-size: 16px; }
.overall-duration { margin: 12px 0 0; font-size: 13px; }
.handover-summary { border-top: 1px solid var(--line); padding-top: 16px; margin: 0; font-size: 13px; }
.handover-summary strong { margin-right: 6px; }
@media (max-width: 520px) {
  .date-filters { display: grid; grid-template-columns: 1fr 1fr; }
  .date-filters .field { min-width: 0; }
  .date-filters .p-button { grid-column: 1 / -1; }
}
</style>
