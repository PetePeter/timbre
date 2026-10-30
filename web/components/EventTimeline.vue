<script setup lang="ts">
import type { RecordEvent } from '../api';

defineProps<{ events: RecordEvent[] }>();

function label(event: RecordEvent): string {
  const labels: Record<RecordEvent['type'], string> = {
    'contact.matched': 'Contact matched',
    'call.started': 'Call started',
    'call.blocked': 'Call kept out',
    'call.answered': 'Call answered',
    'call.ended': 'Call ended',
    'call.outcome': 'Call outcome',
    'call.transferred': 'Call transferred',
    'call.agent_started': 'Call agent started',
    'conference.added': 'Conference updated',
    'sms.received': 'Text received',
    'sms.sent': 'Text sent',
    'notify.sent': 'Call summary sent',
    'notify.failed': 'Call summary failed',
    'policy.evaluated': 'Rule checked',
    'notification.sent': 'Notification sent',
    'retention.purged': 'Retention cleanup',
  };
  return labels[event.type];
}

function description(event: RecordEvent): string {
  const details = event.details;
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  switch (event.type) {
    case 'contact.matched': return text(details.contact) || 'Contact details matched.';
    case 'policy.evaluated': {
      const outcome = details.allowed === false ? 'Denied' : 'Allowed';
      const reason = text(details.reason);
      return `${outcome} ${text(details.action)}${reason ? `: ${reason}` : ''}`;
    }
    case 'call.transferred': return `Transferred from ${text(details.from) || 'operator'} to ${text(details.to) || 'another operator'}.`;
    case 'call.ended': {
      const reason = text(details.reason);
      const duration = typeof details.durationSeconds === 'number' ? ` · ${formatDuration(details.durationSeconds)}` : '';
      return `${reason || 'Call finished'}${duration}`;
    }
    case 'sms.received':
    case 'sms.sent':
    case 'notification.sent': return text(details.text);
    case 'retention.purged': {
      const recordings = typeof details.recordingsRemoved === 'number' ? details.recordingsRemoved : 0;
      const transcripts = typeof details.transcriptsRemoved === 'number' ? details.transcriptsRemoved : 0;
      return `Removed ${recordings} recording(s) and ${transcripts} transcript(s).`;
    }
    default: return text(details.action) || text(details.contact) || 'Recorded.';
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
</script>

<template>
  <ol class="event-timeline">
    <li v-for="event in events" :key="event.eventId" class="event-row" :class="`event-${event.kind}`">
      <span class="event-marker" aria-hidden="true" />
      <div class="event-content">
        <div class="event-heading"><strong>{{ label(event) }}</strong><time :datetime="event.occurredAt">{{ formatTime(event.occurredAt) }}</time></div>
        <p>{{ description(event) }}</p>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.event-timeline { list-style: none; margin: 0; padding: 0; }
.event-row { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 12px; padding-bottom: 20px; position: relative; }
.event-row:not(:last-child)::before { content: ''; position: absolute; left: 6px; top: 14px; bottom: -1px; width: 2px; background: var(--line); }
.event-marker { z-index: 1; width: 14px; height: 14px; margin-top: 3px; border: 3px solid var(--brand-soft); border-radius: 50%; background: var(--brand); }
.event-sms .event-marker { border-color: var(--green-soft); background: var(--green); }
.event-system .event-marker { border-color: var(--coral-soft); background: var(--coral); }
.event-content { min-width: 0; }
.event-heading { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.event-heading strong { font-size: 13px; }
.event-heading time { color: var(--muted); font-size: 11px; white-space: nowrap; }
.event-content p { color: var(--muted); font-size: 13px; margin-top: 3px; overflow-wrap: anywhere; white-space: pre-wrap; }
@media (max-width: 480px) { .event-heading { align-items: flex-start; flex-direction: column; gap: 2px; } }
</style>
