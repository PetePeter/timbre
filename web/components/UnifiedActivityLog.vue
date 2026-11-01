<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import Button from 'primevue/button';
import CallDetailDrawer from './CallDetailDrawer.vue';
import { api, type ActivityRecordAppend, type RecordSummary, type RecordSearchResult } from '../api';
import { useAppState } from '../app-state';
import { localDateRangeToUtc } from '../record-date-range';
import { formatTimestamp } from '../date-time';
import { matchContactsByNumber } from '../../src/contacts/match-number.js';
import type { AddressBookContact } from '../../src/contacts/contact.js';

interface Row { phoneId: string; phoneName: string; record: RecordSummary }
interface SearchRow { phoneId: string; phoneName: string; result: RecordSearchResult }
const state = useAppState();
const phoneId = ref('all');
const searchText = ref('');
const searchTerm = ref('');
const kind = ref<'all' | 'call' | 'sms'>('all');
const today = localDate(new Date());
const fromDate = ref(today);
const toDate = ref(today);
const rows = ref<Row[]>([]);
const searchRows = ref<SearchRow[]>([]);
const searchStatus = ref<'ready' | 'indexing'>('ready');
const cursors = ref<Record<string, string | null>>({});
const loading = ref(false);
const error = ref('');
const detail = ref<RecordSummary | null>(null);
const detailPhoneId = ref<string | null>(null);
const detailVisible = ref(false);
let sequence = 0;
let detailSequence = 0;
let source: EventSource | undefined;
let searchPoll: ReturnType<typeof setTimeout> | undefined;

const phones = computed(() => state.cfg?.phones ?? []);
const addressBooks = ref<Record<string, AddressBookContact[]>>({});
watch(phones, (list) => {
  for (const phone of list) {
    if (addressBooks.value[phone.id]) continue;
    api.contacts(phone.id).then((contacts) => { addressBooks.value = { ...addressBooks.value, [phone.id]: contacts }; }).catch(() => undefined);
  }
}, { immediate: true });
const visiblePhones = computed(() => phoneId.value === 'all' ? phones.value : phones.value.filter((phone) => phone.id === phoneId.value));
const visibleRows = computed(() => rows.value.filter((row) => kind.value === 'all' || row.record.kind === kind.value));
const visibleSearchRows = computed(() => searchRows.value.filter((row) => kind.value === 'all' || row.result.kind === kind.value));
const hasOlder = computed(() => visiblePhones.value.some((phone) => cursors.value[phone.id]));

watch(() => phones.value.map((phone) => phone.id).join('|'), () => {
  if (phoneId.value !== 'all' && !phones.value.some((phone) => phone.id === phoneId.value)) phoneId.value = 'all';
  if (searchTerm.value) void search(); else void load(true);
}, { immediate: true });
watch(phoneId, () => { detailVisible.value = false; if (searchTerm.value) void search(); else void load(true); });
onMounted(() => {
  if (typeof EventSource === 'undefined') return;
  source = new EventSource(api.activityEventsUrl());
  source.addEventListener('record', onRecordAppend);
});
onBeforeUnmount(() => { source?.close(); if (searchPoll) clearTimeout(searchPoll); });

function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function isCommunication(record: RecordSummary): boolean {
  return record.kind === 'call' || record.kind === 'sms';
}
function sortRows(items: Row[]): Row[] {
  return items.sort((a, b) => Date.parse(b.record.lastEventAt) - Date.parse(a.record.lastEventAt) || b.record.id.localeCompare(a.record.id));
}
async function load(reset: boolean): Promise<void> {
  const current = ++sequence;
  if (searchPoll) clearTimeout(searchPoll);
  searchPoll = undefined;
  searchTerm.value = '';
  searchRows.value = [];
  error.value = '';
  if (reset) { rows.value = []; cursors.value = {}; detailVisible.value = false; }
  if (!visiblePhones.value.length) return;
  let range: ReturnType<typeof localDateRangeToUtc>;
  try { range = localDateRangeToUtc(fromDate.value, toDate.value); }
  catch (cause) { error.value = (cause as Error).message; return; }
  loading.value = true;
  const currentPhones = [...visiblePhones.value];
  const pages = await Promise.allSettled(currentPhones.map(async (phone) => {
    const cursor = reset ? undefined : cursors.value[phone.id];
    if (!reset && !cursor) return { phone, page: null };
    const page = await api.records(phone.id, { ...range, limit: 100, ...(cursor ? { cursor } : {}) });
    return { phone, page };
  }));
  if (current !== sequence) return;
  const next = reset ? [] : [...rows.value];
  const nextCursors = reset ? {} as Record<string, string | null> : { ...cursors.value };
  let failures = 0;
  for (const result of pages) {
    if (result.status === 'rejected') { failures++; continue; }
    const { phone, page } = result.value;
    if (!page) continue;
    nextCursors[phone.id] = page.nextCursor;
    for (const record of page.items) if (isCommunication(record)) next.push({ phoneId: phone.id, phoneName: phone.name, record });
  }
  rows.value = sortRows([...new Map(next.map((row) => [`${row.phoneId}:${row.record.id}`, row])).values()]);
  cursors.value = nextCursors;
  if (failures) error.value = `${failures} phone log${failures === 1 ? '' : 's'} could not be loaded.`;
  loading.value = false;
}
async function search(): Promise<void> {
  const term = searchText.value.trim();
  if (!term) { void load(true); return; }
  if (searchPoll) clearTimeout(searchPoll);
  const current = ++sequence;
  searchTerm.value = term;
  searchRows.value = [];
  error.value = '';
  loading.value = true;
  const results = await Promise.allSettled(visiblePhones.value.map(async (phone) => ({ phone, result: await api.searchRecords(phone.id, term) })));
  if (current !== sequence) return;
  let failures = 0;
  let indexing = false;
  const next: SearchRow[] = [];
  for (const result of results) {
    if (result.status === 'rejected') { failures++; continue; }
    indexing ||= result.value.result.status === 'indexing';
    for (const item of result.value.result.items) if (item.kind === 'call' || item.kind === 'sms') next.push({ phoneId: result.value.phone.id, phoneName: result.value.phone.name, result: item });
  }
  searchRows.value = next.sort((a, b) => Date.parse(b.result.occurredAt) - Date.parse(a.result.occurredAt));
  searchStatus.value = indexing ? 'indexing' : 'ready';
  if (failures) error.value = `${failures} phone search${failures === 1 ? '' : 'es'} failed.`;
  loading.value = false;
  if (indexing) searchPoll = setTimeout(() => { void search(); }, 500);
}
function clearSearch(): void { searchText.value = ''; void load(true); }
async function openDetail(row: Row | SearchRow): Promise<void> {
  const current = ++detailSequence;
  detailPhoneId.value = row.phoneId;
  detail.value = 'record' in row ? row.record : null;
  detailVisible.value = true;
  try {
    const full = await api.record(row.phoneId, 'record' in row ? row.record.id : row.result.id);
    if (current === detailSequence) detail.value = full;
  } catch (cause) { if (current === detailSequence) error.value = (cause as Error).message; }
}
function onRecordAppend(message: Event): void {
  let append: ActivityRecordAppend;
  try { append = JSON.parse((message as MessageEvent<string>).data) as ActivityRecordAppend; }
  catch { return; }
  if (!append || !visiblePhones.value.some((phone) => phone.id === append.phoneId)) return;
  if (searchTerm.value) return;
  const event = append.event;
  if (!event || typeof event.interactionId !== 'string') return;
  let range: ReturnType<typeof localDateRangeToUtc>;
  try { range = localDateRangeToUtc(fromDate.value, toDate.value); }
  catch { return; }
  if (event.occurredAt < range.from || event.occurredAt >= range.to) return;
  const current = sequence;
  void api.record(append.phoneId, event.interactionId).then((record) => {
    if (current !== sequence || !isCommunication(record)) return;
    const phone = phones.value.find((item) => item.id === append.phoneId);
    if (!phone) return;
    rows.value = sortRows([{ phoneId: phone.id, phoneName: phone.name, record }, ...rows.value.filter((row) => row.phoneId !== phone.id || row.record.id !== record.id)]);
    if (detailVisible.value && detailPhoneId.value === phone.id && detail.value?.id === record.id) detail.value = record;
  }).catch(() => undefined);
}
function communicationLabel(kind: string, direction: string | undefined): string {
  const communication = kind === 'sms' ? 'SMS' : 'call';
  if (direction === 'inbound') return `Incoming ${communication}`;
  if (direction === 'outbound') return `Outgoing ${communication}`;
  return kind === 'sms' ? 'Text message' : 'Call';
}
function label(record: RecordSummary): string {
  return communicationLabel(record.kind, record.direction);
}
function searchLabel(result: RecordSearchResult): string {
  return communicationLabel(result.kind, result.direction);
}
function otherNumber(record: RecordSummary): string | undefined {
  return record.direction === 'outbound' ? record.to : record.from;
}
function knownContact(phoneId: string, record: RecordSummary): AddressBookContact | undefined {
  const number = otherNumber(record);
  return number ? matchContactsByNumber(addressBooks.value[phoneId] ?? [], number, number)[0] : undefined;
}
/** The number to offer saving, once the phone's contacts have loaded and none matches. */
function unsavedNumber(phoneId: string | null, record: RecordSummary | null): string | undefined {
  if (!phoneId || !record || !addressBooks.value[phoneId] || knownContact(phoneId, record)) return undefined;
  return otherNumber(record);
}
function contact(row: Row): string {
  const { record } = row;
  const number = otherNumber(record);
  const known = knownContact(row.phoneId, record);
  if (known) return known.name;
  return record.contact && record.contact !== 'Unknown caller' ? record.contact : number || 'Unknown caller';
}
function status(record: RecordSummary): string {
  if (record.blocked) return 'Kept out';
  if (record.kind === 'sms') return record.direction === 'outbound' ? 'Sent' : 'Received';
  if (record.events.some((event) => event.type === 'call.ended')) return 'Ended';
  if (record.events.some((event) => event.type === 'call.answered')) return 'In progress';
  return 'Ringing';
}
function time(value: string): string { return formatTimestamp(value); }
function duration(seconds: number | undefined): string { return seconds === undefined ? '' : ` · ${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function splitSnippet(snippet: string): { text: string; match: boolean }[] {
  const term = searchTerm.value.toLocaleLowerCase();
  const lower = snippet.toLocaleLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let start = 0;
  for (let at = lower.indexOf(term); term && at !== -1; at = lower.indexOf(term, start)) {
    if (at > start) parts.push({ text: snippet.slice(start, at), match: false });
    parts.push({ text: snippet.slice(at, at + term.length), match: true });
    start = at + term.length;
  }
  if (start < snippet.length) parts.push({ text: snippet.slice(start), match: false });
  return parts;
}
</script>

<template>
  <section class="panel unified-log" aria-label="Call and text log">
    <div class="section-heading"><div><h2>Call and text log</h2><p class="muted small">Each call or text appears once. Open a row for details.</p></div><Button label="Refresh" severity="secondary" outlined :loading="loading" @click="searchTerm ? search() : load(true)" /></div>
    <div v-if="!phones.length" class="empty-state"><h2>No phones configured</h2><p>Set up a phone to see calls and texts.</p><RouterLink to="/phones">Set up a phone</RouterLink></div>
    <template v-else>
      <form class="log-controls" role="search" @submit.prevent="search"><input v-model="searchText" type="search" aria-label="Search calls and texts" placeholder="Search calls and texts"><Button type="submit" label="Search" :loading="loading" /><Button v-if="searchTerm" type="button" label="Clear" severity="secondary" outlined @click="clearSearch" /></form>
      <div class="log-controls" aria-label="Log filters"><label>Phone <select v-model="phoneId" aria-label="Phone filter"><option value="all">All phones</option><option v-for="phone in phones" :key="phone.id" :value="phone.id">{{ phone.name }}</option></select></label><label>Show <select v-model="kind" aria-label="Type filter"><option value="all">All</option><option value="call">Calls</option><option value="sms">Texts</option></select></label><template v-if="!searchTerm"><label>From <input v-model="fromDate" type="date" aria-label="Start date" :max="toDate || undefined"></label><label>To <input v-model="toDate" type="date" aria-label="End date" :min="fromDate || undefined"></label><Button label="Apply" severity="secondary" outlined @click="load(true)" /></template></div>
      <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
      <p v-if="loading && !rows.length && !searchRows.length" class="muted small" role="status">Loading activity…</p>
      <p v-else-if="searchTerm && searchStatus === 'indexing'" class="muted small" role="status">Indexing search…</p>
      <div v-if="searchTerm" class="log-list"><button v-for="row in visibleSearchRows" :key="`${row.phoneId}:${row.result.id}`" class="log-row" @click="openDetail(row)"><span class="log-icon" :class="row.result.kind">{{ row.result.direction === 'outbound' ? '↗' : '↙' }}</span><span class="log-main"><strong>{{ searchLabel(row.result) }} · {{ row.result.contact || 'Unknown contact' }}</strong><small class="search-results"><template v-for="(part, index) in splitSnippet(row.result.snippet)" :key="index"><mark v-if="part.match">{{ part.text }}</mark><span v-else>{{ part.text }}</span></template> · {{ row.phoneName }}</small></span><time>{{ time(row.result.occurredAt) }}</time><span aria-hidden="true">›</span></button><p v-if="!loading && !visibleSearchRows.length && searchStatus === 'ready'" class="muted empty-log">No matching calls or texts.</p></div>
      <div v-else class="log-list"><div v-for="row in visibleRows" :key="`${row.phoneId}:${row.record.id}`" class="log-item"><button class="log-row" @click="openDetail(row)"><span class="log-icon" :class="row.record.kind">{{ row.record.direction === 'outbound' ? '↗' : '↙' }}</span><span class="log-main"><strong>{{ label(row.record) }} · {{ contact(row) }}</strong><small>{{ status(row.record) }}{{ duration(row.record.durationSeconds) }} · {{ row.phoneName }}</small></span><time>{{ time(row.record.occurredAt) }}</time><span aria-hidden="true">›</span></button><RouterLink v-if="unsavedNumber(row.phoneId, row.record)" class="log-add" :to="{ path: '/people', query: { add: unsavedNumber(row.phoneId, row.record) } }" :aria-label="`Add ${unsavedNumber(row.phoneId, row.record)} to contacts`">+ Add</RouterLink></div><p v-if="!loading && !visibleRows.length" class="muted empty-log">No calls or texts in this range.</p><div v-if="hasOlder" class="log-more"><Button label="Load older" severity="secondary" outlined :loading="loading" @click="load(false)" /></div></div>
    </template>
  </section>
  <CallDetailDrawer v-model:visible="detailVisible" :phone-id="detailPhoneId" :record="detail" :unsaved-number="unsavedNumber(detailPhoneId, detail)" />
</template>

<style scoped>
.unified-log { min-width: 0; }.section-heading { margin-bottom: 16px; }.log-controls { display: flex; flex-wrap: wrap; gap: 9px; align-items: end; margin-bottom: 12px; }.log-controls > input { min-width: 180px; flex: 1; }.log-controls label { display: grid; gap: 3px; font-size: 11px; color: var(--muted); }.log-controls input,.log-controls select { min-height: 40px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 10px; color: var(--text); background: var(--panel); }.log-list { border-top: 1px solid var(--line); }.log-row { width: 100%; display: grid; grid-template-columns: 42px minmax(0, 1fr) auto 12px; gap: 12px; align-items: center; text-align: left; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--text); padding: 13px 4px; }.log-row:hover { background: var(--soft); }.log-item { display: flex; align-items: center; border-bottom: 1px solid var(--line); }.log-item .log-row { flex: 1; min-width: 0; border-bottom: 0; }.log-add { flex-shrink: 0; padding: 6px 10px; border-radius: 10px; color: var(--brand-ink); background: var(--brand-soft); font-size: 12px; text-decoration: none; white-space: nowrap; }.log-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; background: var(--brand-soft); color: var(--brand-ink); font-size: 19px; }.log-icon.sms { background: var(--green-soft); color: var(--green); }.log-main { min-width: 0; }.log-main strong,.log-main small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.log-main strong { font-size: 13px; }.log-main small { color: var(--muted); font-size: 12px; margin-top: 2px; }.log-row time { color: var(--muted); font-size: 11px; white-space: nowrap; }.empty-log { padding: 30px 5px; text-align: center; }.log-more { padding-top: 15px; text-align: center; }
@media(max-width:640px){.log-row{grid-template-columns:40px minmax(0,1fr) 12px;gap:9px}.log-row time{grid-column:2;grid-row:2;margin-top:-8px}.log-row>span:last-child{grid-column:3;grid-row:1 / 3}}
</style>
