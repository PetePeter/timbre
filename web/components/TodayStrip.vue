<script setup lang="ts">
import { computed } from 'vue';
import type { TodayActivityCounts } from '../activity-feed';

const props = defineProps<{ counts: TodayActivityCounts; loading: boolean }>();
const peak = computed(() => Math.max(0, ...props.counts.hourly));
const chartLabel = computed(() => `Today: ${props.counts.calls} calls, ${props.counts.sms} text messages`);

function height(count: number): string {
  return count === 0 || peak.value === 0 ? '0%' : `${Math.max(8, count / peak.value * 100)}%`;
}
</script>

<template>
  <section class="panel today-panel">
    <div class="section-heading"><h2>Today on the line</h2><span class="muted small">{{ loading ? 'Loading events…' : `${counts.total} recorded events` }}</span></div>
    <div class="today-counts" aria-label="Today's phone activity counts">
      <div><strong>{{ counts.calls }}</strong><span>Calls</span></div>
      <div><strong>{{ counts.sms }}</strong><span>Texts</span></div>
    </div>
    <div class="today-strip" role="img" :aria-label="chartLabel">
      <i v-for="(count, hour) in counts.hourly" :key="hour" :style="{ height: height(count) }" :title="`${hour}:00 · ${count}`" />
    </div>
    <div class="time-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span></div>
  </section>
</template>
