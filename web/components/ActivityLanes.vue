<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import SelectButton from 'primevue/selectbutton';
import FormField from './FormField.vue';
import type { ActivityItem, ActivityLane, ActivityState } from '../activity-feed';

const props = defineProps<{ lanes: ActivityLane[]; loading: boolean; error: string }>();
const selectedPhoneId = ref('');
const options = computed(() => props.lanes.map((lane) => ({ label: lane.phoneName, value: lane.phoneId })));
watch(() => props.lanes.map((lane) => lane.phoneId), (ids) => {
  if (!ids.includes(selectedPhoneId.value)) selectedPhoneId.value = ids[0] ?? '';
}, { immediate: true });

const stateLabels: Record<ActivityState, string> = {
  ringing: 'Ringing', active: 'In progress', ended: 'Ended', blocked: 'Blocked',
  received: 'Received', sent: 'Sent', running: 'Running', completed: 'Completed', failed: 'Failed',
};

function icon(item: ActivityItem): string {
  return item.kind === 'call' ? '☎' : item.kind === 'sms' ? '✉' : '•';
}

function time(value: string): string {
  const at = new Date(value);
  const now = new Date();
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return at.toLocaleString([], sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
</script>

<template>
  <FormField v-if="lanes.length > 1" v-slot="{ inputAttrs }" :value="selectedPhoneId" hint="Choose a phone activity lane." :block-save="false">
    <SelectButton v-model="selectedPhoneId" v-bind="inputAttrs" class="lane-selector" :options="options" option-label="label" option-value="value" :allow-empty="false" aria-label="Phone activity lane" />
  </FormField>
  <p v-if="error" class="activity-message" role="status">{{ error }}</p>
  <p v-else-if="loading && lanes.length === 0" class="activity-message" role="status">Loading phone activity…</p>
  <p v-else-if="lanes.length === 0" class="activity-message">No phones are configured yet.</p>
  <div v-else class="activity-board" aria-label="Phone activity by line">
    <section v-for="lane in lanes" :key="lane.phoneId" class="activity-lane" :class="{ 'mobile-hidden': lane.phoneId !== selectedPhoneId }">
      <div class="lane-heading"><h2>{{ lane.phoneName }}</h2><span class="pill">{{ lane.items.length }}</span></div>
      <article v-for="item in lane.items" :key="item.id" class="activity-card">
        <h3>{{ item.title }}</h3>
        <p><span class="activity-kind" aria-hidden="true">{{ icon(item) }}</span><span v-if="item.detail">{{ item.detail }} · </span>{{ stateLabels[item.state] }}</p>
        <div class="activity-meta"><span>{{ time(item.occurredAt) }}</span><span v-if="item.durationSeconds !== undefined">{{ duration(item.durationSeconds) }}</span></div>
      </article>
      <p v-if="lane.items.length === 0" class="lane-empty">No recent phone events.</p>
    </section>
  </div>
</template>
