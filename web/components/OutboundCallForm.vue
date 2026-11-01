<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import Button from 'primevue/button';
import FormField from './FormField.vue';
import { callDestinationError, callTaskError } from '../field-validation';
import { matchContactsByNumber } from '../../src/contacts/match-number.js';
import type { AddressBookContact } from '../../src/contacts/contact.js';

const phones = ref<Array<{ id: string; name: string }>>([]);
const phoneId = ref('');
const to = ref('');
const task = ref('');
const loadingPhones = ref(true);
const busy = ref(false);
const error = ref('');
const interactionId = ref('');
const attempted = ref(false);
const contacts = ref<AddressBookContact[]>([]);
const matchedName = computed(() => matchContactsByNumber(contacts.value, to.value, to.value.trim())[0]?.name ?? '');

watch(phoneId, async (id) => {
  contacts.value = [];
  if (!id) return;
  try { contacts.value = await api.contacts(id); } catch { /* the name hint is optional */ }
});

onMounted(async () => {
  try {
    phones.value = (await api.status()).phones.map(({ id, name }) => ({ id, name }));
    phoneId.value = phones.value[0]?.id ?? '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingPhones.value = false;
  }
});

async function submit(): Promise<void> {
  attempted.value = true;
  if (!phoneId.value || callDestinationError(to.value) || callTaskError(task.value)) return;
  busy.value = true;
  error.value = '';
  interactionId.value = '';
  try {
    const result = await api.createCall(phoneId.value, { to: to.value, task: task.value });
    interactionId.value = result.interactionId;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="panel stack" aria-labelledby="call-for-me-title" :aria-busy="loadingPhones || busy">
    <div>
      <h2 id="call-for-me-title">Call for me</h2>
      <p class="muted">Ask the call agent to handle a call on your behalf.</p>
    </div>
    <p v-if="loadingPhones" class="muted">Loading phone lines…</p>
    <form v-else class="stack" novalidate @submit.prevent="submit">
      <label v-if="phones.length > 1" class="field">
        <span>Phone line</span>
        <FormField v-slot="{ inputAttrs }" :value="phoneId" hint="Choose the phone line to place the call." :attempted="attempted" :block-save="false">
          <select v-model="phoneId" v-bind="inputAttrs" name="phoneId" required>
            <option v-for="phone in phones" :key="phone.id" :value="phone.id">{{ phone.name }}</option>
          </select>
        </FormField>
      </label>
      <label class="field">
        <span>To</span>
        <FormField v-slot="{ inputAttrs }" :value="to" hint="Enter a contact name or destination (up to 120 characters)." :validate="callDestinationError" :attempted="attempted" :block-save="false"><input v-model="to" v-bind="inputAttrs" name="to" type="text" autocomplete="tel" minlength="1" maxlength="120" required></FormField>
        <small v-if="matchedName" class="muted" role="status">{{ matchedName }}</small>
      </label>
      <label class="field">
        <span>Task</span>
        <FormField v-slot="{ inputAttrs }" :value="task" hint="Task must contain 1 to 4000 characters." :validate="callTaskError" :attempted="attempted" :block-save="false"><textarea v-model="task" v-bind="inputAttrs" name="task" rows="3" minlength="1" maxlength="4000" required /></FormField>
      </label>
      <p v-if="phones.length === 0" class="muted">Add a phone line before requesting a call.</p>
      <Button type="submit" :label="busy ? 'Requesting…' : 'Call for me'" :disabled="busy || !phoneId" />
    </form>
    <p v-if="interactionId" role="status">Call requested. Interaction ID: <code>{{ interactionId }}</code></p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.field textarea { resize: vertical; }
</style>
