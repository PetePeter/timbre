<script setup lang="ts">
import type { CallOutcomeSummary } from '../../src/records/analytics.js';

defineProps<{ outcomes: CallOutcomeSummary[] }>();

function label(outcome: string): string {
  return outcome.replaceAll('_', ' ');
}

function percent(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
</script>

<template>
  <div class="table-wrap">
    <table class="insights-table">
      <thead><tr><th scope="col">Outcome</th><th scope="col">Calls</th><th scope="col">Share</th><th scope="col">Average length</th></tr></thead>
      <tbody>
        <tr v-for="item in outcomes" :key="item.outcome">
          <th scope="row">{{ label(item.outcome) }}</th>
          <td>{{ item.count }}</td>
          <td>{{ percent(item.share) }}</td>
          <td>{{ duration(item.averageDurationSeconds) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrap { overflow-x: auto; }
.insights-table { width: 100%; min-width: 500px; border-collapse: collapse; text-align: left; }
.insights-table th, .insights-table td { padding: 11px 10px; border-bottom: 1px solid var(--line); font-size: 13px; }
.insights-table thead th { color: var(--muted); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
.insights-table tbody th { font-weight: 600; text-transform: capitalize; }
.insights-table td { font-variant-numeric: tabular-nums; }
</style>
