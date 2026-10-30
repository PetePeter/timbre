<script setup lang="ts">
import { reactive, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { MCP_SECRET_MASK } from '../../src/config/mcp-secret-mask';
import FormField from './FormField.vue';

const props = defineProps<{ label: string; modelValue: Record<string, string>; busy: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, string>] }>();
const secretDrafts = reactive<Record<string, string>>({});
const keyDrafts = reactive<Record<string, string>>({});

watch(() => ({ ...props.modelValue }), (next, previous) => {
  for (const key of Object.keys(secretDrafts)) {
    if (!(key in next)) delete secretDrafts[key];
    else if (next[key] === MCP_SECRET_MASK && previous?.[key] && previous[key] !== MCP_SECRET_MASK) secretDrafts[key] = '';
  }
  for (const key of Object.keys(keyDrafts)) if (!(key in next)) delete keyDrafts[key];
});

function secretValue(key: string): string {
  return secretDrafts[key] ?? (props.modelValue[key] === MCP_SECRET_MASK ? '' : props.modelValue[key] ?? '');
}

function setSecret(key: string, value: string) {
  secretDrafts[key] = value;
  emit('update:modelValue', { ...props.modelValue, [key]: value || (props.modelValue[key] === MCP_SECRET_MASK ? MCP_SECRET_MASK : '') });
}

function keyValue(key: string): string { return keyDrafts[key] ?? key; }

function setKeyDraft(key: string, value: string) { keyDrafts[key] = value; }

function commitKey(key: string) {
  const nextKey = (keyDrafts[key] ?? key).trim();
  delete keyDrafts[key];
  if (!nextKey || nextKey === key || Object.hasOwn(props.modelValue, nextKey)) return;
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(props.modelValue)) next[name === key ? nextKey : name] = value;
  if (Object.hasOwn(secretDrafts, key)) {
    secretDrafts[nextKey] = secretDrafts[key];
    delete secretDrafts[key];
  }
  emit('update:modelValue', next);
}

function addEntry() {
  const base = props.label.includes('header') ? 'HEADER' : 'VARIABLE';
  let key = base;
  let suffix = 2;
  while (Object.hasOwn(props.modelValue, key)) key = `${base}_${suffix++}`;
  emit('update:modelValue', { ...props.modelValue, [key]: '' });
}

function removeEntry(key: string) {
  const next = { ...props.modelValue };
  delete next[key];
  delete secretDrafts[key];
  delete keyDrafts[key];
  emit('update:modelValue', next);
}
</script>

<template>
  <div class="stack mcp-secret-map">
    <h4>{{ label }}</h4>
    <div v-for="(value, key, index) in modelValue" :key="key" class="row mcp-secret-row">
      <FormField v-slot="{ inputAttrs }" :value="keyValue(key)" hint="Server stores string keys; no fixed length limit is enforced."><InputText :model-value="keyValue(key)" v-bind="inputAttrs" :readonly="value === MCP_SECRET_MASK" :disabled="busy" :aria-label="`${label} ${index + 1} name`" @update:model-value="setKeyDraft(key, String($event ?? ''))" @change="commitKey(key)" /></FormField>
      <FormField v-slot="{ inputAttrs }" :value="secretValue(key)" hint="Server stores string values; leave empty to clear this value."><InputText :model-value="secretValue(key)" v-bind="inputAttrs" type="password" autocomplete="new-password" :disabled="busy" :placeholder="value === MCP_SECRET_MASK ? 'Saved · enter to replace' : 'Value'" :aria-label="`${label} ${index + 1} secret`" @update:model-value="setSecret(key, String($event ?? ''))" /></FormField>
      <Button severity="danger" text :disabled="busy" :aria-label="`Remove ${label} ${index + 1}`" @click="removeEntry(key)">✕</Button>
    </div>
    <Button severity="secondary" :disabled="busy" :aria-label="`Add ${label}`" @click="addEntry">+ {{ label.replace(/^MCP /, '') }}</Button>
  </div>
</template>
