<script setup lang="ts">
import AppSelect from './AppSelect.vue';
import Textarea from 'primevue/textarea';
import type { SmsAutoReplyMode, SmsAutoReplyPolicy } from '../../src/phone/sms-auto-reply-policy.js';

const props = withDefaults(defineProps<{
  modelValue: SmsAutoReplyPolicy;
  labelContext: 'Default' | 'Rule' | 'Schedule slot';
  disabled?: boolean;
}>(), { disabled: false });
const emit = defineEmits<{ 'update:modelValue': [policy: SmsAutoReplyPolicy] }>();

const options = [
  { label: 'No automatic reply', value: 'none' },
  { label: 'Agent replies', value: 'agent' },
  { label: 'Fixed reply', value: 'fixed' },
];

function asMode(value: unknown): SmsAutoReplyMode {
  return options.some((option) => option.value === value) ? value as SmsAutoReplyMode : 'none';
}

function update(mode: SmsAutoReplyMode) {
  emit('update:modelValue', { mode, text: mode === 'fixed' ? props.modelValue.text : '' });
}
</script>

<template>
  <div class="sms-auto-reply-fields">
    <label class="field">
      <span>SMS auto-reply</span>
      <AppSelect :model-value="modelValue.mode" :options="options" option-label="label" option-value="value" :aria-label="`${labelContext} SMS auto-reply`" :disabled="disabled" @update:model-value="update(asMode($event))" />
    </label>
    <label v-if="modelValue.mode === 'fixed'" class="field fixed-reply-field">
      <span>Fixed reply text</span>
      <Textarea :model-value="modelValue.text" :aria-label="`${labelContext} fixed SMS reply`" rows="2" auto-resize maxlength="640" :disabled="disabled" @update:model-value="emit('update:modelValue', { mode: 'fixed', text: String($event ?? '').slice(0, 640) })" />
    </label>
    <small v-else-if="modelValue.mode === 'agent'" class="reply-help">The agent receives the message as untrusted text and can send one reply to that sender.</small>
  </div>
</template>

<style scoped>
.sms-auto-reply-fields { display: grid; grid-column: 1 / -1; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.field { display: grid; gap: 6px; min-width: 0; }
.field span { color: var(--muted); font-size: .9rem; }
.reply-help { align-self: end; color: var(--muted); }
.fixed-reply-field { grid-column: 1 / -1; }
@media (max-width: 640px) { .sms-auto-reply-fields { grid-template-columns: 1fr; } .fixed-reply-field { grid-column: auto; } }
</style>
