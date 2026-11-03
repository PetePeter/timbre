<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import AppSelect from './AppSelect.vue';
import type { AddressBookContact } from '../api';
import type { InboundRule } from '../../src/phone/inbound-call-policy.js';
import type { PhoneContactPermissions } from '../../src/phone/phone-config.js';
import FormField from './FormField.vue';
import PhoneContactPermissionsEditor from './PhoneContactPermissionsEditor.vue';
import { phonePatternError } from '../field-validation';

const props = withDefaults(defineProps<{
  modelValue: InboundRule[];
  contacts: AddressBookContact[];
  disabled?: boolean;
  showPermissions?: boolean;
  ariaLabel?: string;
  addLabel?: string;
  countryCode?: string;
}>(), { disabled: false, showPermissions: false, ariaLabel: 'Inbound rules', addLabel: 'Add rule', countryCode: '+61' });
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
  if (!target || props.disabled || kind.value === 'number' && phonePatternError(target, props.countryCode)) return;
  emit('update:modelValue', [...props.modelValue, { kind: kind.value, value: target }]);
  value.value = '';
}

function remove(index: number) {
  emit('update:modelValue', props.modelValue.filter((_, item) => item !== index));
}

function updatePermissions(index: number, permissions: PhoneContactPermissions) {
  emit('update:modelValue', props.modelValue.map((rule, item) => item === index ? { ...rule, ...permissions } : rule));
}
</script>

<template>
  <div class="rule-editor">
    <ul v-if="modelValue.length" class="rules" :aria-label="ariaLabel">
      <li v-for="(rule, index) in modelValue" :key="`${rule.kind}:${rule.value}:${index}`" class="rule-row">
        <div class="rule-content">
          <div class="rule-info">
            <strong>{{ nameFor(rule) }}</strong>
            <small>{{ detailFor(rule) }}</small>
          </div>
          <PhoneContactPermissionsEditor v-if="showPermissions" :model-value="rule" :disabled="disabled" @update:model-value="updatePermissions(index, $event)" />
        </div>
        <Button type="button" severity="secondary" text aria-label="Remove rule" :disabled="disabled" @click="remove(index)">×</Button>
      </li>
    </ul>
    <p v-else class="muted empty-rules">No rules added.</p>
    <div class="row rule-add-row">
      <FormField v-slot="{ inputAttrs }" :value="kind" hint="Choose whether this rule targets a contact, group, or number."><AppSelect v-model="kind" v-bind="inputAttrs" :options="kinds" option-label="label" option-value="value" aria-label="Choose entry type" :disabled="disabled" /></FormField>
      <FormField v-if="kind === 'number'" v-slot="{ inputAttrs }" :value="value" hint="Enter a valid phone number or a prefix ending in *." :validate="(input) => phonePatternError(input, countryCode)"><InputText v-model="value" v-bind="inputAttrs" type="tel" inputmode="tel" aria-label="Exact number or prefix" placeholder="+61… or +61…*" :disabled="disabled" @keydown.enter.prevent="add" /></FormField>
      <FormField v-else v-slot="{ inputAttrs }" :value="value" hint="Choose one of the available contacts or groups."><AppSelect v-model="value" v-bind="inputAttrs" :options="targetOptions" option-label="label" option-value="value" :aria-label="kind === 'contact' ? 'Choose contact' : 'Choose group'" :disabled="disabled || !targetOptions.length" /></FormField>
      <Button type="button" :label="addLabel" :aria-label="addLabel" :disabled="disabled || !value.trim()" @click="add" />
    </div>
  </div>
</template>

<style scoped>
.rule-editor { display: grid; gap: 14px; margin-top: 18px; }
.rules { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 9px; margin: 0; padding: 0; list-style: none; }
.rule-row { display: flex; align-items: flex-start; gap: 12px; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--surface-soft, var(--surface)); }
.rule-content { display: grid; min-width: 0; flex: 1; gap: 2px; }
.rule-info { display: grid; gap: 2px; min-width: 0; flex: 1; }
.rule-info small { color: var(--muted); }
.empty-rules { margin: 0; }
.rule-add-row > * { min-width: 0; flex: 1; }
@media (max-width: 640px) { .rule-add-row { align-items: stretch; flex-direction: column; } }
</style>
