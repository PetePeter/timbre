<script setup lang="ts">
import ToggleSwitch from 'primevue/toggleswitch';
import type { PhoneContactPermissions } from '../../src/phone/phone-config.js';

const props = withDefaults(defineProps<{
  modelValue: Partial<PhoneContactPermissions>;
  disabled?: boolean;
}>(), { disabled: false });
const emit = defineEmits<{ 'update:modelValue': [permissions: PhoneContactPermissions] }>();

const defaults: PhoneContactPermissions = { callIn: true, callOut: false, smsIn: false, smsOut: false, conf: false };
const options: Array<{ key: keyof PhoneContactPermissions; label: string }> = [
  { key: 'callIn', label: 'Call in' },
  { key: 'callOut', label: 'Call out' },
  { key: 'smsIn', label: 'SMS in' },
  { key: 'smsOut', label: 'SMS out' },
  { key: 'conf', label: 'Conference' },
];

function value(key: keyof PhoneContactPermissions): boolean {
  return props.modelValue[key] ?? defaults[key];
}

function update(key: keyof PhoneContactPermissions, checked: boolean) {
  const permissions: PhoneContactPermissions = {
    callIn: value('callIn'), callOut: value('callOut'), smsIn: value('smsIn'), smsOut: value('smsOut'), conf: value('conf'),
  };
  permissions[key] = checked;
  emit('update:modelValue', permissions);
}
</script>

<template>
  <fieldset class="permission-editor" aria-label="Allowed actions" :disabled="disabled">
    <legend>Allowed actions</legend>
    <label v-for="option in options" :key="option.key" class="control-row">
      <span>{{ option.label }}</span>
      <ToggleSwitch :model-value="value(option.key)" :aria-label="option.label" :disabled="disabled" @update:model-value="update(option.key, $event)" />
    </label>
  </fieldset>
</template>

<style scoped>
.permission-editor { display: grid; gap: 2px; margin: 8px 0 0; padding: 0; border: 0; }
.permission-editor legend { margin-bottom: 4px; font-size: .9rem; font-weight: 600; }
.permission-editor .control-row { display: flex; min-height: 34px; align-items: center; justify-content: space-between; gap: 12px; }</style>
