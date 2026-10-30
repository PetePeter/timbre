<script setup lang="ts">
import { computed } from 'vue';
import type { RecordSearchResult } from '../api';

const props = defineProps<{
  query: string;
  status: 'indexing' | 'ready';
  items: RecordSearchResult[];
}>();
const emit = defineEmits<{ select: [result: RecordSearchResult] }>();

const highlightPattern = computed(() => {
  const terms = [...new Set(tokenize(props.query))].sort((a, b) => b.length - a.length);
  return terms.length ? new RegExp(`(${terms.map(escapeRegex).join('|')})`, 'giu') : null;
});

function segments(text: string): Array<{ text: string; highlighted: boolean }> {
  const pattern = highlightPattern.value;
  if (!pattern) return [{ text, highlighted: false }];
  return text.split(pattern).filter(Boolean).map((part) => ({
    text: part,
    highlighted: tokenize(part).some((token) => tokenize(props.query).includes(token)),
  }));
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '';
}

function tokenize(value: string): string[] { return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
</script>

<template>
  <div class="search-results" aria-live="polite">
    <p v-if="status === 'indexing'" class="muted" role="status">Building search index… Results will appear when it’s ready.</p>
    <ul v-else-if="items.length" class="search-result-list">
      <li v-for="item in items" :key="item.id">
        <button class="search-result" type="button" @click="emit('select', item)">
          <span class="search-result-meta">{{ item.contact || (item.kind === 'sms' ? 'Text message' : 'Call') }} · {{ formatTime(item.occurredAt) }}</span>
          <span class="search-result-snippet">
            <template v-for="(part, index) in segments(item.snippet)" :key="index">
              <mark v-if="part.highlighted">{{ part.text }}</mark><template v-else>{{ part.text }}</template>
            </template>
          </span>
        </button>
      </li>
    </ul>
    <p v-else class="muted" role="status">No matches found.</p>
  </div>
</template>

<style scoped>
.search-result-list { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
.search-result { display: grid; gap: 5px; width: 100%; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text); text-align: left; cursor: pointer; }
.search-result:hover { border-color: var(--accent); }
.search-result-meta { color: var(--muted); font-size: 12px; }
.search-result-snippet { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
.search-result-snippet mark { border-radius: 3px; background: var(--accent-soft); color: var(--text); }
</style>
