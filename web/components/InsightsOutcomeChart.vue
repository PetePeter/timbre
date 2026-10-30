<script setup lang="ts">
import type { CallOutcomeSummary } from '../../src/records/analytics.js';

defineProps<{ outcomes: CallOutcomeSummary[] }>();

function label(outcome: string): string {
  return outcome.replaceAll('_', ' ');
}
</script>

<template>
  <ol class="outcome-chart" aria-label="Call outcome mix">
    <li v-for="item in outcomes" :key="item.outcome" class="outcome-row">
      <span class="outcome-name">{{ label(item.outcome) }}</span>
      <span
        class="bar-track"
        role="progressbar"
        :aria-label="`${label(item.outcome)} share`"
        :aria-valuenow="Math.round(item.share * 100)"
        aria-valuemin="0"
        aria-valuemax="100"
      ><span class="bar-fill" :style="{ width: `${item.share * 100}%` }" /></span>
      <span class="outcome-count">{{ item.count }}</span>
    </li>
  </ol>
</template>

<style scoped>
.outcome-chart { display: grid; gap: 10px; padding: 0; margin: 0; list-style: none; }
.outcome-row { display: grid; grid-template-columns: minmax(110px, 150px) minmax(80px, 1fr) 34px; gap: 12px; align-items: center; font-size: 13px; }
.outcome-name { text-transform: capitalize; }
.bar-track { display: block; height: 12px; overflow: hidden; border-radius: 999px; background: var(--soft); }
.bar-fill { display: block; height: 100%; border-radius: inherit; background: var(--brand); }
.outcome-count { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 520px) {
  .outcome-row { grid-template-columns: minmax(95px, 120px) minmax(50px, 1fr) 28px; gap: 8px; font-size: 12px; }
}
</style>
