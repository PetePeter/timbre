<script setup lang="ts">
import { ref, watch } from 'vue';
import Button from 'primevue/button';
import ContactForm from '../components/ContactForm.vue';
import ContactList from '../components/ContactList.vue';
import PinEditor from '../components/PinEditor.vue';
import { api, type AddressBookContact, type AddressBookContactInput } from '../api';
import { useAppState } from '../app-state';

const state = useAppState();
const contacts = ref<AddressBookContact[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const editing = ref<AddressBookContact | null>(null);
const formOpen = ref(false);
let loadSequence = 0;

async function load(phoneId: string | undefined) {
  const sequence = ++loadSequence;
  contacts.value = [];
  editing.value = null;
  formOpen.value = false;
  error.value = '';
  if (!phoneId) return;
  loading.value = true;
  try {
    const next = await api.contacts(phoneId);
    if (sequence === loadSequence) contacts.value = next;
  } catch (err) {
    if (sequence === loadSequence) error.value = (err as Error).message;
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

watch(() => state.selectedPhone?.id, (phoneId) => { void load(phoneId); }, { immediate: true });

async function save(input: AddressBookContactInput) {
  const phoneId = state.selectedPhone?.id;
  if (!phoneId) return;
  saving.value = true;
  error.value = '';
  try {
    if (editing.value) await api.updateContact(phoneId, editing.value.id, input);
    else await api.addContact(phoneId, input);
    if (state.selectedPhone?.id !== phoneId) return;
    formOpen.value = false;
    editing.value = null;
    await load(phoneId);
  } catch (err) { error.value = (err as Error).message; }
  finally { saving.value = false; }
}

async function savePin(contact: AddressBookContact, pin: string) {
  const phoneId = state.selectedPhone?.id;
  if (!phoneId) return;
  saving.value = true;
  error.value = '';
  try {
    await api.updateContact(phoneId, contact.id, {
      name: contact.name, numbers: contact.numbers, group: contact.group,
      trusted: contact.trusted, isUser: contact.isUser,
      ...(pin ? { pin } : { clearPin: true }),
    });
    if (state.selectedPhone?.id === phoneId) await load(phoneId);
  } catch (err) { error.value = (err as Error).message; }
  finally { saving.value = false; }
}

async function remove(contact: AddressBookContact) {
  const phoneId = state.selectedPhone?.id;
  if (!phoneId || !confirm(`Delete ${contact.name}?`)) return;
  saving.value = true;
  error.value = '';
  try {
    await api.deleteContact(phoneId, contact.id);
    if (state.selectedPhone?.id === phoneId) await load(phoneId);
  }
  catch (err) { error.value = (err as Error).message; }
  finally { saving.value = false; }
}
</script>

<template>
  <div class="page-heading">
    <div><h1>People</h1><p>Contacts for {{ state.selectedPhone?.name ?? 'your phone' }}.</p></div>
    <Button label="Add contact" aria-label="Add contact" :disabled="!state.selectedPhone || loading || saving" @click="editing = null; formOpen = true" />
  </div>
  <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
  <p v-if="loading" class="muted" role="status">Loading contacts…</p>
  <ContactForm v-if="formOpen" :contact="editing" :busy="saving" @save="save" @cancel="formOpen = false; editing = null" />
  <ContactList v-else :contacts="contacts" :busy="saving || loading" @edit="editing = $event; formOpen = true" @remove="remove" />
  <section v-if="!formOpen && contacts.some((contact) => contact.isUser || contact.trusted)" class="pin-list" aria-labelledby="pin-list-heading">
    <h2 id="pin-list-heading">Caller PINs</h2>
    <article v-for="contact in contacts.filter((entry) => entry.isUser || entry.trusted)" :key="contact.id" class="panel stack pin-contact">
      <h3>{{ contact.name }}</h3>
      <PinEditor :contact="contact" :busy="saving || loading" @save="savePin(contact, $event)" />
    </article>
  </section>
</template>

<style scoped>
.pin-list { display: grid; gap: 0.75rem; margin-top: 1.5rem; }
.pin-contact { margin: 0; }
</style>
