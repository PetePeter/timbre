<script setup lang="ts">
import { ref, watch } from 'vue';
import type { AddressBookContact } from '../../src/contacts/contact.js';
import { contactPinValidationError } from '../field-validation';
import { PinDialStringBuilder } from '../pin-dial-string-builder.js';
import Button from 'primevue/button';
import FormField from './FormField.vue';

const props = withDefaults(defineProps<{
  contact: AddressBookContact;
  busy: boolean;
  lineNumber?: string;
  serverError?: string;
}>(), { lineNumber: '', serverError: '' });
const emit = defineEmits<{ save: [pin: string] }>();
const pin = ref('');
const dialString = ref('');
const usesExampleNumber = ref(false);
const copied = ref(false);
const copyError = ref('');
const dialStringBuilder = new PinDialStringBuilder();
let pendingDialString: ReturnType<PinDialStringBuilder['build']> | null = null;

watch(() => props.busy, (busy, wasBusy) => {
  if (busy || !wasBusy || !pendingDialString) return;
  if (!props.serverError && props.contact.pinSet && !props.contact.pinNeedsReentry) {
    dialString.value = pendingDialString.dialString;
    usesExampleNumber.value = pendingDialString.usesExampleNumber;
  }
  pendingDialString = null;
});

watch(pin, (value) => {
  if (!value) return;
  dialString.value = '';
  copied.value = false;
  copyError.value = '';
});

function save() {
  if (contactPinValidationError(pin.value)) return;
  pendingDialString = dialStringBuilder.build(props.lineNumber, pin.value);
  dialString.value = '';
  copied.value = false;
  copyError.value = '';
  emit('save', pin.value);
  pin.value = '';
}

function clearPin() {
  pendingDialString = null;
  dialString.value = '';
  copied.value = false;
  copyError.value = '';
  pin.value = '';
  emit('save', '');
}

async function copyDialString() {
  try {
    await navigator.clipboard.writeText(dialString.value);
    copied.value = true;
    copyError.value = '';
  } catch {
    copied.value = false;
    copyError.value = 'Copy unavailable. Select the line and copy it manually.';
  }
}
</script>

<template>
  <section class="pin-editor" :aria-label="'Caller PIN for ' + props.contact.name">
    <p v-if="props.contact.pinNeedsReentry" class="pin-status" role="status">PIN needs re-entry</p>
    <p v-else-if="props.contact.pinSet" class="pin-status" role="status">Caller PIN is set.</p>
    <form class="pin-form field-row" @submit.prevent="save">
      <label class="field">
        <span>{{ props.contact.pinSet ? 'Replace caller PIN' : 'Set caller PIN' }}</span>
        <FormField v-slot="{ inputAttrs }" :value="pin" hint="Optional; when set, PIN must contain at least six digits." :validate="contactPinValidationError" :server-error="props.serverError" :block-save="false">
          <input v-model="pin" v-bind="inputAttrs" class="p-inputtext" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{6,}" minlength="6" :disabled="props.busy" aria-label="Caller PIN" />
        </FormField>
      </label>
      <div class="row">
        <Button type="submit" label="Save PIN" :disabled="props.busy" />
        <Button v-if="props.contact.pinSet" type="button" label="Clear PIN" severity="secondary" aria-label="Clear caller PIN" :disabled="props.busy" @click="clearPin" />
      </div>
    </form>
    <section v-if="dialString" class="pin-dial-string" aria-label="Phone-book dial string">
      <p>Save this exact line in the caller’s phone book to dial the PIN:</p>
      <div class="pin-dial-row">
        <code>{{ dialString }}</code>
        <Button type="button" label="Copy line" severity="secondary" aria-label="Copy caller PIN dial string" @click="copyDialString" />
      </div>
      <p v-if="usesExampleNumber" class="pin-dial-note">Example only. Replace +61400000000 with this phone’s number before saving.</p>
      <p class="pin-dial-note">Two commas add a short pause (about two seconds each on many phones). The PIN challenge accepts input for 30 seconds after it opens. A semicolon (;) waits for you to tap to continue. The final # submits the PIN.</p>
      <p v-if="copied" role="status">Copied.</p>
      <p v-if="copyError" role="alert">{{ copyError }}</p>
    </section>
  </section>
</template>

<style scoped>
.pin-editor { display: grid; gap: 0.5rem; }
.pin-form input { max-width: 14rem; }
.pin-status { margin: 0; }
.pin-dial-string { display: grid; gap: 0.5rem; }
.pin-dial-string p { margin: 0; }
.pin-dial-row { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75rem; }
.pin-dial-row code { overflow-wrap: anywhere; }
.pin-dial-note { max-width: 48rem; }
</style>
