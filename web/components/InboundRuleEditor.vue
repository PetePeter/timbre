<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import AppSelect from './AppSelect.vue';
import type { AddressBookContact } from '../api';
import type { InboundRule } from '../../src/phone/inbound-call-policy.js';

const props = withDefaults(defineProps<{
  modelValue: InboundRule[];
  contacts: AddressBookContact[];
  disabled?: boolean;
  ariaLabel?: string;
  addLabel?: string;
}>(), { disabled: false, ariaLabel: 'Inbound rules', addLabel: 'Add rule' });
const emit = defineEmits<{ 'update:modelValue': [rules: InboundRule[]] }>();

const kind = ref<InboundRule['kind']>('contact');
const value = ref('');
const kinds = [
  { label: 'Contact', value: 'contact' },
  { label: 'Group', value: 'group' },
  { label: 'Number', value: 'number' },
];
const contactOptions = computed(() => props.contacts.map((contact) => ({ label: contact.name, value: contact.id })));
const groupOptions = computed(() => [...new Set(props.contacts.map((contact) => contact.group.trim()).filter(Boolean))]
  .map((group) => ({ label: group, value: group })));
const targetOptions = computed(() => kind.value === 'contact' ? contactOptions.value : groupOptions.value);

watch(kind, () => { value.value = ''; });
watch(targetOptions, (options) => {
  if (value.value && !options.some((option) => option.value === value.value)) value.value = '';
});

function nameFor(rule: InboundRule): string {
  if (rule.kind === 'contact') return props.contacts.find((contact) => contact.id === rule.value)?.name ?? 'Missing contact';
  if (rule.kind === 'group') return rule.value;
  return rule.value;
}

function detailFor(rule: InboundRule): string {
  if (rule.kind === 'number') return `Number${rule.value.trim().endsWith('*') ? ' prefix' : ''} · ${rule.value}`;
  return rule.kind === 'contact' ? 'Contact' : 'Group';
}

function add() {
  const target = value.value.trim();
  if (!target || props.disabled) return;
  emit('update:modelValue', [...props.modelValue, { kind: kind.value, value: target }]);
  value.value = '';
}

function remove(index: number) {
  emit('update:modelValue', props.modelValue.filter((_, item) => item !== index));
}
</script>

<template>
  <div class="rule-editor">
    <ul v-if="modelValue.length" class="rules" :aria-label="ariaLabel">
      <li v-for="(rule, index) in modelValue" :key="`${rule.kind}:${rule.value}:${index}`" class="rule-row">
        <div class="rule-info">
          <strong>{{ nameFor(rule) }}</strong>
          <small>{{ detailFor(rule) }}</small>
        </div>
        <Button type="button" severity="secondary" text aria-label="Remove rule" :disabled="disabled" @click="remove(index)">×</Button>
      </li>
    </ul>
    <p v-else class="muted empty-rules">No rules added.</p>
    <div class="row rule-add-row">
      <AppSelect v-model="kind" :options="kinds" option-label="label" option-value="value" aria-label="Choose entry type" :disabled="disabled" />
      <InputText v-if="kind === 'number'" v-model="value" aria-label="Exact number or prefix" placeholder="+61… or +61…*" :disabled="disabled" @keydown.enter.prevent="add" />
      <AppSelect v-else v-model="value" :options="targetOptions" option-label="label" option-value="value" :aria-label="kind === 'contact' ? 'Choose contact' : 'Choose group'" :disabled="disabled || !targetOptions.length" />
      <Button type="button" :label="addLabel" :aria-label="addLabel" :disabled="disabled || !value.trim()" @click="add" />
    </div>
  </div>
</template>

<style scoped>
.rule-editor { display: grid; gap: 14px; margin-top: 18px; }
.rules { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
.rule-row { display: flex; align-items: center; gap: 12px; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--surface-soft, var(--surface)); }
.rule-info { display: grid; gap: 2px; min-width: 0; flex: 1; }
.rule-info small { color: var(--muted); }
.empty-rules { margin: 0; }
.rule-add-row > * { min-width: 0; flex: 1; }
@media (max-width: 640px) { .rule-add-row { align-items: stretch; flex-direction: column; } }
</style>
