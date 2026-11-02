<script setup lang="ts">
import { ref, watch } from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { api } from '../api';
import { useThemeOverlayProps } from '../theme-overlay';
import { phoneNumberError } from '../field-validation';
import FormField from './FormField.vue';
import ContactNumberInput from './ContactNumberInput.vue';
import type { AddressBookContact } from '../../src/contacts/contact.js';

const props = withDefaults(defineProps<{
  visible: boolean;
  phoneId: string | null;
  phoneName: string;
  countryCode?: string;
}>(), { countryCode: '+61' });
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const overlayProps = useThemeOverlayProps();
const contacts = ref<AddressBookContact[]>([]);
const to = ref('');
const text = ref('');
const attempted = ref(false);
const busy = ref(false);
const error = ref('');
const result = ref('');
let contactRequest = 0;

function destinationError(value: unknown): string | null {
  if (typeof value === 'string' && contacts.value.some((contact) =>
    contact.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase() && contact.numbers.length > 0)) return null;
  return phoneNumberError(value, props.countryCode, true);
}

function resolvedDestination(): string {
  const contact = contacts.value.find((candidate) =>
    candidate.name.toLocaleLowerCase() === to.value.trim().toLocaleLowerCase() && candidate.numbers.length > 0);
  return contact?.numbers[0] ?? to.value.trim();
}

function smsTextError(value: unknown): string | null {
  return typeof value === 'string' && !!value.trim() && value.length <= 2_000
    ? null
    : 'Message must contain 1 to 2000 characters.';
}

watch(() => [props.visible, props.phoneId] as const, async ([visible, phoneId], previous) => {
  const request = ++contactRequest;
  if (!visible || !phoneId) {
    contacts.value = [];
    to.value = '';
    text.value = '';
    attempted.value = false;
    busy.value = false;
    error.value = '';
    result.value = '';
    return;
  }
  if (!previous || !previous[0] || previous[1] !== phoneId) {
    to.value = '';
    text.value = '';
    attempted.value = false;
    error.value = '';
    result.value = '';
  }
  contacts.value = [];
  try {
    const loaded = await api.contacts(phoneId);
    if (request === contactRequest) contacts.value = loaded;
  } catch {
    // Contact suggestions are optional; a number can still be entered directly.
  }
}, { immediate: true });

async function submit(): Promise<void> {
  attempted.value = true;
  const phoneId = props.phoneId;
  if (!phoneId || busy.value || destinationError(to.value) || smsTextError(text.value)) return;
  busy.value = true;
  error.value = '';
  result.value = '';
  try {
    const response = await api.sendOwnerSms(phoneId, { to: resolvedDestination(), text: text.value });
    if (response.sent) result.value = 'SMS sent.';
    else error.value = response.reason || 'SMS was not sent.';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function setVisible(visible: boolean): void {
  if (!visible && busy.value) return;
  emit('update:visible', visible);
}
</script>

<template>
  <Dialog v-bind="overlayProps" :visible="visible" modal :draggable="false" class="test-sms-dialog" header="Test SMS" @update:visible="setVisible">
    <p class="muted">Send a policy-checked SMS from {{ phoneName }}.</p>
    <form class="stack" novalidate @submit.prevent="submit">
      <label class="field">
        <span>To</span>
        <FormField v-slot="{ inputAttrs }" :value="to" hint="Enter a contact name or a valid phone number." :validate="destinationError" :attempted="attempted" :block-save="false">
          <ContactNumberInput v-model="to" v-bind="inputAttrs" :contacts="contacts" name="to" type="text" autocomplete="tel" inputmode="tel" maxlength="32" required :disabled="busy || !phoneId" />
        </FormField>
      </label>
      <label class="field">
        <span>Message</span>
        <FormField v-slot="{ inputAttrs }" :value="text" hint="Message must contain 1 to 2000 characters." :validate="smsTextError" :attempted="attempted" :block-save="false">
          <textarea v-model="text" v-bind="inputAttrs" name="text" rows="4" maxlength="2000" required :disabled="busy || !phoneId" />
        </FormField>
      </label>
      <div class="row">
        <Button type="submit" :label="busy ? 'Sending…' : 'Send test SMS'" :loading="busy" :disabled="busy || !phoneId" />
        <Button label="Close" severity="secondary" outlined :disabled="busy" @click="setVisible(false)" />
      </div>
    </form>
    <p v-if="result" role="status">{{ result }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </Dialog>
</template>
