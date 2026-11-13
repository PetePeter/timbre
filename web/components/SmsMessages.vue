<script setup lang="ts">
import { computed } from 'vue';
import type { RecordSummary } from '../api';
import { formatTimestamp } from '../date-time';

const props = defineProps<{ record: RecordSummary }>();
const messages = computed(() => props.record.events
  .filter((event) => event.type === 'sms.received' || event.type === 'sms.sent')
  .filter((event) => typeof event.details.text === 'string' && event.details.text.length > 0)
  .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)));
</script>

<template>
  <section class="sms-messages" aria-label="Text messages">
    <h2>Messages</h2>
    <ol v-if="messages.length" class="message-list">
      <li v-for="event in messages" :key="event.eventId" class="message" :class="event.type === 'sms.sent' ? 'outbound' : 'inbound'">
        <div class="message-heading">
          <strong>{{ event.type === 'sms.sent' ? 'Sent' : 'Received' }}</strong>
          <time :datetime="event.occurredAt">{{ formatTimestamp(event.occurredAt) }}</time>
        </div>
        <p>{{ event.details.text }}</p>
      </li>
    </ol>
    <p v-else class="muted">No message content was recorded.</p>
  </section>
</template>

<style scoped>
.sms-messages { display: grid; gap: 12px; }
.sms-messages h2 { border-bottom: 1px solid var(--line); padding-bottom: 10px; }
.message-list { display: grid; gap: 12px; list-style: none; margin: 0; padding: 0; }
.message { max-width: min(100%, 510px); padding: 12px 15px; border: 1px solid var(--line); border-radius: 12px; background: var(--soft); overflow-wrap: anywhere; white-space: pre-wrap; }
.message.outbound { justify-self: end; background: var(--green-soft); }
.message-heading { display: flex; justify-content: space-between; gap: 20px; color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.message-heading strong { color: var(--text); }
.message p { margin: 0; }
</style>
