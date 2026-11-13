<script setup lang="ts">
import { RouterLink } from 'vue-router';
import Drawer from 'primevue/drawer';
import EventTimeline from './EventTimeline.vue';
import CallArtifacts from './CallArtifacts.vue';
import SmsMessages from './SmsMessages.vue';
import { useThemeOverlayProps } from '../theme-overlay';
import type { RecordSummary } from '../api';
import { formatTimestamp } from '../date-time';

defineProps<{ visible: boolean; phoneId: string | null; record: RecordSummary | null; unsavedNumber?: string }>();
defineEmits<{ 'update:visible': [visible: boolean] }>();
const overlayProps = useThemeOverlayProps();

function heading(record: RecordSummary): string {
  return record.contact || record.from || record.to || 'Timbre activity';
}

function direction(record: RecordSummary): string {
  if (record.direction === 'inbound') return 'Incoming';
  if (record.direction === 'outbound') return 'Outgoing';
  return record.kind === 'sms' ? 'Text message' : 'Activity';
}

function outcome(record: RecordSummary): string {
  const value = record.events.find((event) => event.type === 'call.outcome')?.details.outcome;
  return typeof value === 'string' ? value.replaceAll('_', ' ') : '';
}

function actionLabel(record: RecordSummary): string {
  return record.action === 'call.outcome' ? 'ended' : record.action;
}
</script>

<template>
  <Drawer
    :visible="visible"
    v-bind="overlayProps"
    modal
    position="right"
    :header="record ? heading(record) : 'Activity details'"
    :style="{ width: 'min(620px, 100vw)' }"
    @update:visible="$emit('update:visible', $event)"
  >
    <section v-if="record" class="detail-content">
      <div class="detail-summary">
        <span class="pill" :class="record.blocked ? 'rose' : record.kind === 'sms' ? 'green' : 'sky'">{{ direction(record) }}</span>
        <span>{{ actionLabel(record) }}</span>
        <span v-if="record.kind === 'call' && outcome(record)" class="pill sky outcome-pill">Outcome: {{ outcome(record) }}</span>
        <span>{{ formatTimestamp(record.occurredAt) }}</span>
        <span v-if="record.durationSeconds !== undefined">{{ Math.floor(record.durationSeconds / 60) }}m {{ record.durationSeconds % 60 }}s</span>
      </div>
      <RouterLink v-if="unsavedNumber" class="detail-add" :to="{ path: '/people', query: { add: unsavedNumber } }" @click="$emit('update:visible', false)">+ Add {{ unsavedNumber }} to contacts</RouterLink>
      <SmsMessages v-if="record.kind === 'sms'" :record="record" />
      <h2>What Timbre did</h2>
      <EventTimeline :events="record.events" :hide-sms-text="record.kind === 'sms'" />
      <CallArtifacts v-if="record.kind === 'call'" :visible="visible" :phone-id="phoneId" :record="record" />
    </section>
  </Drawer>
</template>

<style scoped>
.detail-content { display: grid; gap: 18px; }
.detail-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; color: var(--muted); font-size: 12px; }
.detail-content h2 { border-bottom: 1px solid var(--line); padding-bottom: 10px; }
.outcome-pill { text-transform: capitalize; }
.detail-add { justify-self: start; padding: 6px 10px; border-radius: 10px; color: var(--brand-ink); background: var(--brand-soft); font-size: 12px; text-decoration: none; }
</style>
