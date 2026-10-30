<script setup lang="ts">
import { ref } from 'vue';
import type { AddressBookContact } from '../../src/contacts/contact.js';

const props = defineProps<{ contact: AddressBookContact; busy: boolean }>();
const emit = defineEmits<{ save: [pin: string] }>();
const pin = ref('');
const error = ref('');

function save() {
  if (!/^\d{6,}$/.test(pin.value)) {
    error.value = 'PIN must contain at least six digits.';
    return;
  }
  error.value = '';
  emit('save', pin.value);
  pin.value = '';
}

function clearPin() {
  error.value = '';
  pin.value = '';
  emit('save', '');
}
</script>

<template>
  <section class="pin-editor" :aria-label="`Caller PIN for ${props.contact.name}`">
    <p v-if="props.contact.pinNeedsReentry" class="pin-status" role="status">PIN needs re-entry</p>
    <p v-else-if="props.contact.pinSet" class="pin-status" role="status">Caller PIN is set.</p>
    <form class="pin-form" @submit.prevent="save">
      <label class="field">
        <span>{{ props.contact.pinSet ? 'Replace caller PIN' : 'Set caller PIN' }}</span>
        <input v-model="pin" class="p-inputtext" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{6,}" minlength="6" :disabled="props.busy" aria-label="Caller PIN" />
      </label>
      <div class="row">
        <button type="submit" :disabled="props.busy">Save PIN</button>
        <button v-if="props.contact.pinSet" type="button" aria-label="Clear caller PIN" :disabled="props.busy" @click="clearPin">Clear PIN</button>
      </div>
      <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    </form>
  </section>
</template>

<style scoped>
.pin-editor { display: grid; gap: 0.5rem; }
.pin-form { display: flex; align-items: end; flex-wrap: wrap; gap: 0.75rem; }
.pin-form input { max-width: 14rem; }
.pin-status { margin: 0; }
</style>
