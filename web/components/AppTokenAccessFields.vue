<script setup lang="ts">
import { computed } from 'vue';
import type { AppAction, PhoneEntry } from '../api';
import { appTokenActionsError } from '../field-validation';
import FormField from './FormField.vue';

const props = withDefaults(defineProps<{
  phones: PhoneEntry[];
  phoneId: string;
  actions: AppAction[];
  disabled?: boolean;
  attempted?: boolean;
}>(), { disabled: false, attempted: false });
const emit = defineEmits<{
  (event: 'update:phoneId', value: string): void;
  (event: 'update:actions', value: AppAction[]): void;
}>();

const actionOptions: Array<{ id: AppAction; label: string }> = [
  { id: 'sms.list', label: 'List and read SMS' },
  { id: 'sms.send', label: 'Send SMS' },
  { id: 'calls.list', label: 'List calls' },
  { id: 'calls.make', label: 'Make calls' },
  { id: 'calls.receive', label: 'Receive calls' },
  { id: 'calls.conference', label: 'Conference calls (needs Make calls)' },
  { id: 'contacts.list', label: 'List contacts' },
];
const selectedPhoneId = computed({
  get: () => props.phoneId,
  set: (value: string) => emit('update:phoneId', value),
});
const selectedActions = computed({
  get: () => props.actions,
  set: (value: AppAction[]) => emit('update:actions', value),
});
</script>

<template>
  <label class="field"><span>Phone access</span>
    <FormField v-slot="{ inputAttrs }" :value="phoneId" hint="Choose one phone or all phones." :block-save="false">
      <select v-model="selectedPhoneId" v-bind="inputAttrs" aria-label="Phone access" :disabled="disabled">
        <option value="*">All phones</option>
        <option v-for="phone in phones" :key="phone.id" :value="phone.id">{{ phone.name }}</option>
      </select>
    </FormField>
  </label>
  <FormField v-slot="{ inputAttrs }" :value="actions" hint="Choose at least one valid action." :validate="appTokenActionsError" :attempted="attempted" :block-save="false">
    <fieldset class="stack" :disabled="disabled" v-bind="inputAttrs">
      <legend>Allowed actions</legend>
      <label v-for="action in actionOptions" :key="action.id" class="control-row">
        <span>{{ action.label }}</span><input v-model="selectedActions" type="checkbox" :value="action.id" :aria-label="'Allow ' + action.label" />
      </label>
    </fieldset>
  </FormField>
</template>
