<script setup lang="ts">
import InputNumber from 'primevue/inputnumber';
import AppSelect from './AppSelect.vue';
import type { PhoneLineConfig } from '../../src/phone/phone-config.js';

type SpamSettings = PhoneLineConfig['spam'];

const props = withDefaults(defineProps<{ modelValue: SpamSettings; disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ 'update:modelValue': [value: SpamSettings] }>();

const actions = [
  { label: 'Screen with the phone agent', value: 'screen' },
  { label: 'Block the caller', value: 'block' },
];

function updateThreshold(value: number | null | undefined) {
  if (Number.isInteger(value) && value! >= 0 && value! <= 100) {
    emit('update:modelValue', { ...props.modelValue, threshold: value! });
  }
}

function updateAction(action: SpamSettings['action']) {
  emit('update:modelValue', { ...props.modelValue, action });
}
</script>

<template>
  <div class="spam-editor">
    <label class="field">
      <span>Spam score threshold</span>
      <InputNumber :model-value="modelValue.threshold" input-id="spam-threshold" aria-label="Spam score threshold" :use-grouping="false" :allow-empty="false" :min="0" :max="100" :disabled="disabled" @update:model-value="updateThreshold" />
    </label>
    <label class="field">
      <span>When the score reaches the threshold</span>
      <AppSelect :model-value="modelValue.action" :options="actions" option-label="label" option-value="value" aria-label="Spam action" :disabled="disabled" @update:model-value="updateAction" />
    </label>
  </div>
</template>

<style scoped>
.spam-editor { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 14px; }
</style>
