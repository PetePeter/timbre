<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import AppSelect from './AppSelect.vue';
import SchedulePolicyFields from './SchedulePolicyFields.vue';
import { INBOUND_HANDLING_ACTION_OPTIONS } from '../../src/phone/schedule.js';
import type { AddressBookContact } from '../api';
import type { InboundHandlingAction, InboundHandlingConfig, InboundHandlingPolicy, InboundHandlingRule } from '../../src/phone/inbound-call-policy.js';

const props = withDefaults(defineProps<{
  modelValue: InboundHandlingConfig;
  contacts: AddressBookContact[];
  disabled?: boolean;
}>(), { disabled: false });
const emit = defineEmits<{ 'update:modelValue': [config: InboundHandlingConfig] }>();

const targetKind = ref<'contact' | 'group'>('contact');
const target = ref('');
const action = ref<InboundHandlingAction>('standard');
const kinds = [
  { label: 'Contact', value: 'contact' },
  { label: 'Group', value: 'group' },
];
const actions = INBOUND_HANDLING_ACTION_OPTIONS;
const contactOptions = computed(() => props.contacts.map((contact) => ({ label: contact.name, value: contact.id })));
const groupOptions = computed(() => {
  const groups = new Map<string, string>();
  for (const contact of props.contacts) {
    const group = contact.group.trim();
    if (group && !groups.has(group.toLocaleLowerCase())) groups.set(group.toLocaleLowerCase(), group);
  }
  return [...groups.values()].map((group) => ({ label: group, value: group }));
});
const targetOptions = computed(() => targetKind.value === 'contact' ? contactOptions.value : groupOptions.value);

watch(targetKind, () => { target.value = ''; });
watch(targetOptions, (options) => {
  if (target.value && !options.some((option) => option.value === target.value)) target.value = '';
});

function updateDefaultPolicy(policy: InboundHandlingPolicy) {
  emit('update:modelValue', { ...props.modelValue, default: policy });
}

function updateRule(index: number, changes: Partial<InboundHandlingRule>) {
  const rules = [...props.modelValue.rules];
  rules[index] = { ...rules[index], ...changes };
  emit('update:modelValue', { ...props.modelValue, rules });
}

function addRule() {
  const value = target.value.trim();
  if (!value || props.disabled || props.modelValue.rules.some((rule) =>
    rule.kind === targetKind.value && (rule.kind === 'group'
      ? rule.value.toLocaleLowerCase() === value.toLocaleLowerCase()
      : rule.value === value))) return;
  emit('update:modelValue', {
    ...props.modelValue,
    rules: [...props.modelValue.rules, { kind: targetKind.value, value, action: action.value, greeting: '', instructions: '' }],
  });
  target.value = '';
}

function removeRule(index: number) {
  emit('update:modelValue', { ...props.modelValue, rules: props.modelValue.rules.filter((_, i) => i !== index) });
}

function targetName(rule: InboundHandlingRule): string {
  if (rule.kind === 'group') return rule.value;
  return props.contacts.find((contact) => contact.id === rule.value)?.name ?? 'Missing contact';
}
</script>

<template>
  <div class="handling-editor">
    <div class="default-policy">
      <SchedulePolicyFields :model-value="modelValue.default" label-context="Default" :disabled="disabled" @update:model-value="updateDefaultPolicy" />
    </div>

    <ul v-if="modelValue.rules.length" class="rules" aria-label="Per-contact handling rules">
      <li v-for="(rule, index) in modelValue.rules" :key="`${rule.kind}:${rule.value}`" class="rule">
        <div class="rule-heading">
          <div><strong>{{ targetName(rule) }}</strong><small>{{ rule.kind === 'contact' ? 'Contact' : 'Group' }}</small></div>
          <Button type="button" severity="secondary" text aria-label="Remove handling rule" :disabled="disabled" @click="removeRule(index)">×</Button>
        </div>
        <SchedulePolicyFields :model-value="rule" label-context="Rule" :disabled="disabled" @update:model-value="updateRule(index, $event)" />
      </li>
    </ul>
    <p v-else class="muted empty-rules">No per-contact handling rules.</p>

    <div class="rule-add">
      <AppSelect v-model="targetKind" :options="kinds" option-label="label" option-value="value" aria-label="Handling target type" :disabled="disabled" />
      <AppSelect v-model="target" :options="targetOptions" option-label="label" option-value="value" :aria-label="targetKind === 'contact' ? 'Handling contact' : 'Handling group'" :disabled="disabled || !targetOptions.length" />
      <AppSelect v-model="action" :options="actions" option-label="label" option-value="value" aria-label="Handling action" :disabled="disabled" />
      <Button type="button" label="Add handling rule" aria-label="Add handling rule" :disabled="disabled || !target" @click="addRule" />
    </div>
  </div>
</template>

<style scoped>
.handling-editor { display: grid; gap: 16px; margin-top: 18px; }
.default-policy { display: grid; }
.rules { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.rule { display: grid; gap: 12px; border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: var(--surface-soft, var(--surface)); }
.rule-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.rule-heading > div { display: grid; gap: 2px; }
.rule-heading small { color: var(--muted); }
.empty-rules { margin: 0; }
.rule-add { display: flex; align-items: center; gap: 10px; }
.rule-add > * { min-width: 0; flex: 1; }
@media (max-width: 640px) {
  .rule-add { align-items: stretch; flex-direction: column; }
}
</style>
