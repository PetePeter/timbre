<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import AppSelect from './AppSelect.vue';
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
const actions: Array<{ label: string; value: InboundHandlingAction }> = [
  { label: 'Standard handling', value: 'standard' },
  { label: 'Always put through', value: 'always-through' },
  { label: 'Take a message', value: 'message' },
  { label: 'Block caller', value: 'block' },
];
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

function updateDefault<K extends keyof InboundHandlingPolicy>(key: K, value: InboundHandlingPolicy[K]) {
  emit('update:modelValue', { ...props.modelValue, default: { ...props.modelValue.default, [key]: value } });
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

function asAction(value: unknown, fallback: InboundHandlingAction): InboundHandlingAction {
  return actions.some((option) => option.value === value) ? value as InboundHandlingAction : fallback;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function targetName(rule: InboundHandlingRule): string {
  if (rule.kind === 'group') return rule.value;
  return props.contacts.find((contact) => contact.id === rule.value)?.name ?? 'Missing contact';
}
</script>

<template>
  <div class="handling-editor">
    <div class="default-policy">
      <label class="field">
        <span>Default handling</span>
        <AppSelect :model-value="modelValue.default.action" :options="actions" option-label="label" option-value="value" aria-label="Default handling action" :disabled="disabled" @update:model-value="updateDefault('action', asAction($event, modelValue.default.action))" />
      </label>
      <label class="field">
        <span>Default greeting</span>
        <InputText :model-value="modelValue.default.greeting" aria-label="Default greeting" placeholder="Optional; {caller} and {name} are available" :disabled="disabled" @update:model-value="updateDefault('greeting', asText($event))" />
      </label>
      <label class="field">
        <span>Default agent instructions</span>
        <Textarea :model-value="modelValue.default.instructions" aria-label="Default instructions" rows="2" auto-resize :disabled="disabled" @update:model-value="updateDefault('instructions', asText($event))" />
      </label>
    </div>

    <ul v-if="modelValue.rules.length" class="rules" aria-label="Per-contact handling rules">
      <li v-for="(rule, index) in modelValue.rules" :key="`${rule.kind}:${rule.value}`" class="rule">
        <div class="rule-heading">
          <div><strong>{{ targetName(rule) }}</strong><small>{{ rule.kind === 'contact' ? 'Contact' : 'Group' }}</small></div>
          <Button type="button" severity="secondary" text aria-label="Remove handling rule" :disabled="disabled" @click="removeRule(index)">×</Button>
        </div>
        <div class="rule-fields">
          <label class="field">
            <span>Handling action</span>
            <AppSelect :model-value="rule.action" :options="actions" option-label="label" option-value="value" aria-label="Rule action" :disabled="disabled" @update:model-value="updateRule(index, { action: asAction($event, rule.action) })" />
          </label>
          <label class="field">
            <span>Custom greeting</span>
            <InputText :model-value="rule.greeting" aria-label="Rule greeting" placeholder="Optional; {caller} and {name} are available" :disabled="disabled" @update:model-value="updateRule(index, { greeting: asText($event) })" />
          </label>
          <label class="field">
            <span>Agent instructions</span>
            <Textarea :model-value="rule.instructions" aria-label="Rule instructions" rows="2" auto-resize :disabled="disabled" @update:model-value="updateRule(index, { instructions: asText($event) })" />
          </label>
        </div>
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
.default-policy, .rule-fields { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.default-policy > :last-child, .rule-fields > :last-child { grid-column: 1 / -1; }
.field { display: grid; gap: 6px; min-width: 0; }
.field span { color: var(--muted); font-size: .9rem; }
.rules { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.rule { display: grid; gap: 12px; border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: var(--surface-soft, var(--surface)); }
.rule-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.rule-heading > div { display: grid; gap: 2px; }
.rule-heading small { color: var(--muted); }
.empty-rules { margin: 0; }
.rule-add { display: flex; align-items: center; gap: 10px; }
.rule-add > * { min-width: 0; flex: 1; }
@media (max-width: 640px) {
  .default-policy, .rule-fields { grid-template-columns: 1fr; }
  .default-policy > :last-child, .rule-fields > :last-child { grid-column: auto; }
  .rule-add { align-items: stretch; flex-direction: column; }
}
</style>
