<script setup lang="ts">
import { ref, watch } from 'vue';
import Button from 'primevue/button';
import AppSelect from '../components/AppSelect.vue';
import CallDetailDrawer from '../components/CallDetailDrawer.vue';
import { api, type RecordQueryOptions, type RecordSummary } from '../api';
import { useAppState } from '../app-state';
import { localDateRangeToUtc } from '../record-date-range';

const state = useAppState();
const filterOptions = [
  { label: 'Everything', value: 'all' },
  { label: 'Calls', value: 'calls' },
  { label: 'Texts', value: 'sms' },
  { label: 'Conferences', value: 'conferences' },
  { label: 'Kept out', value: 'blocked' },
];
const today = localDateString(new Date());
const fromDate = ref(today);
const toDate = ref(today);
const filter = ref<NonNullable<RecordQueryOptions['filter']>>('all');
const records = ref<RecordSummary[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const error = ref('');
const detailVisible = ref(false);
const detail = ref<RecordSummary | null>(null);
let loadSequence = 0;
let detailSequence = 0;

watch(() => state.selectedPhone?.id, () => { void load(true); }, { immediate: true });

async function load(reset: boolean): Promise<void> {
  const phoneId = state.selectedPhone?.id;
  const sequence = ++loadSequence;
  if (reset) {
    records.value = [];
    nextCursor.value = null;
    detail.value = null;
    detailVisible.value = false;
  }
  error.value = '';
  if (!phoneId) return;
  loading.value = true;
  try {
    const range = localDateRangeToUtc(fromDate.value, toDate.value);
    const page = await api.records(phoneId, {
      ...range,
      limit: 25,
      filter: filter.value,
      ...(!reset && nextCursor.value ? { cursor: nextCursor.value } : {}),
    });
    if (sequence !== loadSequence) return;
    records.value = reset ? page.items : [...records.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } catch (err) {
    if (sequence === loadSequence) error.value = (err as Error).message;
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

async function openDetail(item: RecordSummary): Promise<void> {
  const phoneId = state.selectedPhone?.id;
  if (!phoneId) return;
  const sequence = ++detailSequence;
  detail.value = item;
  detailVisible.value = true;
  error.value = '';
  try {
    const full = await api.record(phoneId, item.id);
    if (sequence === detailSequence && state.selectedPhone?.id === phoneId) detail.value = full;
  } catch (err) {
    if (sequence === detailSequence) error.value = (err as Error).message;
  }
}

function localDateString(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function label(item: RecordSummary): string {
  return item.contact || item.from || item.to || 'Unknown caller';
}

function kindLabel(item: RecordSummary): string {
  if (item.blocked) return 'Kept out';
  if (item.kind === 'sms') return item.direction === 'outbound' ? 'Text sent' : 'Text received';
  if (item.kind === 'call') return item.direction === 'outbound' ? 'Outgoing call' : 'Incoming call';
  return item.action;
}

function direction(item: RecordSummary): string {
  if (item.direction === 'inbound') return 'Incoming';
  if (item.direction === 'outbound') return 'Outgoing';
  return '—';
}
</script>

<template>
  <div class="page-heading">
    <div><h1>Log</h1><p>Calls, texts, and the actions Timbre took for {{ state.selectedPhone?.name ?? 'your phone' }}.</p></div>
    <Button label="Refresh" severity="secondary" outlined :loading="loading" :disabled="!state.selectedPhone" @click="load(true)" />
  </div>

  <p v-if="error" class="error-banner" role="alert">{{ error }}</p>

  <section class="panel log-panel" aria-label="Call and text log">
    <div class="log-filters">
      <label class="field"><span>From</span><input v-model="fromDate" type="date" aria-label="Start date" /></label>
      <label class="field"><span>To</span><input v-model="toDate" type="date" aria-label="End date" /></label>
      <label class="field filter-select"><span>Show</span><AppSelect v-model="filter" :options="filterOptions" option-label="label" option-value="value" aria-label="Filter log" /></label>
      <Button label="Apply" :disabled="loading || !state.selectedPhone" @click="load(true)" />
    </div>

    <p v-if="loading && !records.length" class="muted" role="status">Loading activity…</p>
    <div v-else-if="!records.length" class="empty-state log-empty">
      <div class="empty-icon" aria-hidden="true">◷</div>
      <h2>No activity in this date range</h2>
      <p>Try a wider range or another filter. New calls and texts will appear here with a timeline of Timbre’s actions.</p>
    </div>
    <div v-else class="log-table-wrap">
      <table class="log-table">
        <thead><tr><th scope="col">When</th><th scope="col">Contact</th><th scope="col">Direction</th><th scope="col">Type</th><th scope="col">Action</th><th scope="col">Duration</th></tr></thead>
        <tbody>
          <tr v-for="item in records" :key="item.id">
            <td :title="formatTime(item.occurredAt)">{{ formatTime(item.occurredAt) }}</td>
            <td><Button class="record-link" link :label="label(item)" @click="openDetail(item)" /></td>
            <td>{{ direction(item) }}</td>
            <td><span class="pill" :class="item.blocked ? 'rose' : item.kind === 'sms' ? 'green' : 'sky'">{{ kindLabel(item) }}</span></td>
            <td>{{ item.action }}</td>
            <td>{{ item.durationSeconds === undefined ? '—' : `${Math.floor(item.durationSeconds / 60)}m ${item.durationSeconds % 60}s` }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="nextCursor" class="log-more">
      <span class="muted small">Showing {{ records.length }} records</span>
      <Button label="Load older" severity="secondary" outlined :loading="loading" @click="load(false)" />
    </div>
  </section>

  <CallDetailDrawer v-model:visible="detailVisible" :phone-id="state.selectedPhone?.id ?? null" :record="detail" />
</template>

<style scoped>
.log-panel { padding: 18px; }
.log-filters { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; margin-bottom: 18px; }
.log-filters .field { min-width: 150px; }
.filter-select { width: 190px; }
.log-filters input { min-height: 42px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text); padding: 8px 10px; }
.log-table-wrap { overflow-x: auto; }
.log-table { width: 100%; border-collapse: collapse; text-align: left; min-width: 690px; }
.log-table th { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.log-table td { padding: 13px 12px; border-bottom: 1px solid var(--line); font-size: 13px; white-space: nowrap; }
.log-table tbody tr:last-child td { border-bottom: 0; }
.record-link { padding: 0; font-weight: 650; }
.log-empty { padding: 48px 20px; }
.log-empty h2 { margin-bottom: 8px; }
.log-more { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 10px 2px; border-top: 1px solid var(--line); }
@media (max-width: 640px) {
  .log-panel { padding: 14px; }
  .log-filters { display: grid; grid-template-columns: 1fr 1fr; align-items: end; }
  .log-filters .field { min-width: 0; }
  .filter-select { width: auto; grid-column: 1 / -1; }
  .log-filters .p-button { grid-column: 1 / -1; }
}
</style>
