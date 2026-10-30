<script setup lang="ts">
import { computed } from 'vue';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import AppSelect from './AppSelect.vue';
import SmsAutoReplyEditor from './SmsAutoReplyEditor.vue';
import { INBOUND_HANDLING_ACTION_OPTIONS } from '../../src/phone/schedule.js';
import type { InboundHandlingAction, InboundHandlingPolicy } from '../../src/phone/inbound-call-policy.js';

const props = withDefaults(defineProps<{
  modelValue: InboundHandlingPolicy;
  labelContext: 'Default' | 'Rule' | 'Schedule slot';
  disabled?: boolean;
}>(), { disabled: false });
const emit = defineEmits<{ 'update:modelValue': [policy: InboundHandlingPolicy] }>();

const labels = computed(() => props.labelContext === 'Rule'
  ? { action: 'Rule action', greeting: 'Rule greeting', instructions: 'Rule instructions' }
  : {
    action: `${props.labelContext} handling action`,
    greeting: `${props.labelContext} greeting`,
    instructions: `${props.labelContext} instructions`,
  });

function update<K extends keyof InboundHandlingPolicy>(key: K, value: InboundHandlingPolicy[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function asAction(value: unknown, fallback: InboundHandlingAction): InboundHandlingAction {
  return INBOUND_HANDLING_ACTION_OPTIONS.some((option) => option.value === value) ? value as InboundHandlingAction : fallback;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
</script>

<template>
  <div class="policy-fields">
    <label class="field">
      <span>Handling action</span>
      <AppSelect :model-value="modelValue.action" :options="INBOUND_HANDLING_ACTION_OPTIONS" option-label="label" option-value="value" :aria-label="labels.action" :disabled="disabled" @update:model-value="update('action', asAction($event, modelValue.action))" />
    </label>
    <label class="field">
      <span>Greeting</span>
      <InputText :model-value="modelValue.greeting" :aria-label="labels.greeting" placeholder="Optional; {caller} and {name} are available" :disabled="disabled" @update:model-value="update('greeting', asText($event))" />
    </label>
    <label class="field instructions-field">
      <span>Agent instructions</span>
      <Textarea :model-value="modelValue.instructions" :aria-label="labels.instructions" rows="2" auto-resize :disabled="disabled" @update:model-value="update('instructions', asText($event))" />
    </label>
    <SmsAutoReplyEditor class="sms-auto-reply-field" :model-value="modelValue.smsAutoReply" :label-context="labelContext" :disabled="disabled" @update:model-value="update('smsAutoReply', $event)" />
  </div>
</template>

<style scoped>
.policy-fields { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.field { display: grid; gap: 6px; min-width: 0; }
.field span { color: var(--muted); font-size: .9rem; }
.instructions-field { grid-column: 1 / -1; }
.sms-auto-reply-field { grid-column: 1 / -1; }
@media (max-width: 640px) {
  .policy-fields { grid-template-columns: 1fr; }
  .instructions-field { grid-column: auto; }
}
</style>
