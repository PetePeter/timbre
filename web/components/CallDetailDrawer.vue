<script setup lang="ts">
import Drawer from 'primevue/drawer';
import EventTimeline from './EventTimeline.vue';
import CallArtifacts from './CallArtifacts.vue';
import { useThemeOverlayProps } from '../theme-overlay';
import type { RecordSummary } from '../api';

defineProps<{ visible: boolean; phoneId: string | null; record: RecordSummary | null }>();
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(value));
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
        <span>{{ formatDate(record.occurredAt) }}</span>
        <span v-if="record.durationSeconds !== undefined">{{ Math.floor(record.durationSeconds / 60) }}m {{ record.durationSeconds % 60 }}s</span>
      </div>
      <h2>What Timbre did</h2>
      <EventTimeline :events="record.events" />
      <CallArtifacts v-if="record.kind === 'call'" :visible="visible" :phone-id="phoneId" :record="record" />
    </section>
  </Drawer>
</template>

<style scoped>
.detail-content { display: grid; gap: 18px; }
.detail-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; color: var(--muted); font-size: 12px; }
.detail-content h2 { border-bottom: 1px solid var(--line); padding-bottom: 10px; }
.outcome-pill { text-transform: capitalize; }
</style>
