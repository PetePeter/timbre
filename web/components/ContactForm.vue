<script setup lang="ts">
import { ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import ToggleSwitch from 'primevue/toggleswitch';
import type { AddressBookContact, AddressBookContactInput, SummaryNotificationPreference } from '../api';
import FormField from './FormField.vue';
import { contactNumbersError } from '../field-validation';

const props = withDefaults(defineProps<{ contact: AddressBookContact | null; busy: boolean; countryCode?: string; error?: string; initialNumber?: string }>(), { countryCode: '+61', error: '', initialNumber: '' });
const emit = defineEmits<{ save: [contact: AddressBookContactInput]; cancel: [] }>();
const name = ref('');
const numbers = ref('');
const group = ref('');
const trusted = ref(false);
const isUser = ref(false);
const transferTarget = ref(false);
const defaultTransfer = ref(false);
const attempted = ref(false);
const summaryNotifications = ref<SummaryNotificationPreference[]>([]);
const summaryNotificationOptions: Array<{ value: SummaryNotificationPreference; label: string }> = [
  { value: 'all', label: 'All calls' },
  { value: 'missed', label: 'Missed calls' },
  { value: 'handed_over', label: 'Handed over' },
  { value: 'left_message', label: 'Left a message' },
];
let summaryNotificationsTouched = false;

const contactNameError = (value: unknown) => typeof value === 'string' && value.trim() ? null : 'Contact name is required.';
const numberError = (value: unknown) => contactNumbersError(value, props.countryCode);
const nameServerError = () => props.error === 'Contact name is required.' ? props.error : '';
const numberServerError = () => /^(At least one phone number is required|Enter a valid phone number)/.test(props.error) ? props.error : '';

watch(() => [props.contact, props.initialNumber] as const, ([contact, initialNumber]) => {
  name.value = contact?.name ?? '';
  numbers.value = contact?.numbers.join('\n') ?? initialNumber;
  group.value = contact?.group ?? '';
  trusted.value = contact?.trusted ?? false;
  isUser.value = contact?.isUser ?? false;
  transferTarget.value = contact?.transferTarget ?? false;
  defaultTransfer.value = contact?.defaultTransfer ?? false;
  summaryNotifications.value = [...(contact?.summaryNotifications ?? [])];
  attempted.value = false;
  summaryNotificationsTouched = false;
}, { immediate: true });

watch(transferTarget, (enabled) => { if (!enabled) defaultTransfer.value = false; });

function submit() {
  attempted.value = true;
  if (contactNameError(name.value) || numberError(numbers.value)) return;
  const includeSummaryNotifications = isUser.value && (
    !props.contact || !props.contact.isUser || props.contact.summaryNotifications !== undefined || summaryNotificationsTouched
  );
  emit('save', {
    name: name.value,
    numbers: numbers.value.split(/\r?\n/).map((number) => number.trim()).filter(Boolean),
    group: group.value,
    trusted: trusted.value,
    isUser: isUser.value,
    transferTarget: transferTarget.value,
    defaultTransfer: defaultTransfer.value,
    ...(includeSummaryNotifications ? { summaryNotifications: [...summaryNotifications.value] } : {}),
  });
}
</script>

<template>
  <form class="panel stack contact-form" aria-label="Contact details" novalidate @submit.prevent="submit">
    <h2>{{ contact ? 'Edit contact' : 'Add contact' }}</h2>
    <label class="field"><span>Name</span><FormField v-slot="{ inputAttrs }" :value="name" hint="Required; whitespace-only names are rejected." :validate="contactNameError" :server-error="nameServerError()" :attempted="attempted" :block-save="false"><InputText v-model="name" v-bind="inputAttrs" aria-label="Name" autocomplete="name" required :disabled="busy" /></FormField></label>
    <label class="field"><span>Phone numbers</span><FormField v-slot="{ inputAttrs }" :value="numbers" hint="Enter at least one number; each must normalize to E.164 with no more than 15 digits." :validate="numberError" :server-error="numberServerError()" :attempted="attempted" :block-save="false"><textarea v-model="numbers" v-bind="inputAttrs" class="p-inputtext" aria-label="Phone numbers" rows="3" placeholder="One number per line" required inputmode="tel" :disabled="busy" /></FormField></label>
    <label class="field"><span>Group</span><FormField v-slot="{ inputAttrs }" :value="group" hint="Optional; no fixed length limit is enforced." :block-save="false"><InputText v-model="group" v-bind="inputAttrs" aria-label="Group" placeholder="Family, work, …" :disabled="busy" /></FormField></label>
    <FormField v-slot="{ inputAttrs }" :value="trusted" hint="The server stores this as on or off." :block-save="false">
      <label class="control-row" for="contact-trusted"><span>Trusted</span><ToggleSwitch v-model="trusted" :pt="{ input: inputAttrs }" input-id="contact-trusted" aria-label="Trusted" :disabled="busy" /></label>
    </FormField>
    <FormField v-slot="{ inputAttrs }" :value="isUser" hint="The server stores this as on or off." :block-save="false">
      <label class="control-row" for="contact-user"><span>This is me</span><ToggleSwitch v-model="isUser" :pt="{ input: inputAttrs }" input-id="contact-user" aria-label="User" :disabled="busy" /></label>
    </FormField>
    <FormField v-slot="{ inputAttrs }" :value="transferTarget" hint="Allow the phone agent to transfer callers to this contact." :block-save="false">
      <label class="control-row" for="contact-transfer-target"><span>Transfer target</span><ToggleSwitch v-model="transferTarget" :pt="{ input: inputAttrs }" input-id="contact-transfer-target" aria-label="Transfer target" :disabled="busy" /></label>
    </FormField>
    <FormField v-slot="{ inputAttrs }" :value="defaultTransfer" hint="Use this contact when a caller asks for a person without naming one." :block-save="false">
      <label class="control-row" for="contact-default-transfer"><span>Default transfer (catch-all)</span><ToggleSwitch v-model="defaultTransfer" :pt="{ input: inputAttrs }" input-id="contact-default-transfer" aria-label="Default transfer" :disabled="busy || !transferTarget" /></label>
    </FormField>
    <FormField v-if="isUser" v-slot="{ inputAttrs }" :value="summaryNotifications" hint="Optional; choose any of the four call summary types to receive." :block-save="false">
      <fieldset class="summary-notifications" v-bind="inputAttrs" :disabled="busy">
        <legend>Call summary texts</legend>
        <label v-for="option in summaryNotificationOptions" :key="option.value" class="control-row">
          <span>{{ option.label }}</span>
          <input v-model="summaryNotifications" type="checkbox" :value="option.value" :aria-label="option.label" @change="summaryNotificationsTouched = true" />
        </label>
      </fieldset>
    </FormField>
    <div class="row">
      <Button type="submit" label="Save contact" aria-label="Save contact" :loading="busy" />
      <Button type="button" label="Cancel" severity="secondary" :disabled="busy" @click="emit('cancel')" />
    </div>
  </form>
</template>

<style scoped>
.contact-form { max-width: 640px; }
.contact-form textarea { resize: vertical; }
.summary-notifications { display: grid; gap: 0.25rem; margin: 0; padding: 0; border: 0; }
.summary-notifications legend { margin-bottom: 0.25rem; font-weight: 600; }
</style>
