<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import ContactForm from '../components/ContactForm.vue';
import ContactList from '../components/ContactList.vue';
import PinEditor from '../components/PinEditor.vue';
import { api, type AddressBookContact, type AddressBookContactInput } from '../api';
import { useAppState } from '../app-state';
import { contactGroups, filterContacts, type ContactFilter } from '../contact-filter';

const state = useAppState();
const contacts = ref<AddressBookContact[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const pinSaveError = ref('');
const editing = ref<AddressBookContact | null>(null);
const formOpen = ref(false);
const pinOpenId = ref<string | null>(null);
const newNumber = ref('');
const contactFilter = ref<ContactFilter>({ kind: 'all' });
const contactSearch = ref('');
const groups = computed(() => contactGroups(contacts.value));
const visibleContacts = computed(() => filterContacts(contacts.value, contactFilter.value, contactSearch.value));
const route = useRoute();
const router = useRouter();
let loadSequence = 0;
let currentPhoneId: string | undefined;

async function load(phoneId: string | undefined) {
  const sequence = ++loadSequence;
  contacts.value = [];
  error.value = '';
  pinSaveError.value = '';
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

watch(() => state.selectedPhone?.id, (phoneId) => {
  if (currentPhoneId !== undefined && currentPhoneId !== phoneId) {
    editing.value = null;
    formOpen.value = false;
    newNumber.value = '';
    pinOpenId.value = null;
  }
  currentPhoneId = phoneId;
  contactFilter.value = { kind: 'all' };
  contactSearch.value = '';
  void load(phoneId);
}, { immediate: true });

// The log links here with ?add=<number> to save an unknown caller.
watch(() => route.query.add, (add) => {
  if (typeof add !== 'string' || !add) return;
  newNumber.value = add;
  editing.value = null;
  formOpen.value = true;
  void router.replace({ query: { ...route.query, add: undefined } });
}, { immediate: true });

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
    newNumber.value = '';
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
  pinSaveError.value = '';
  try {
    await api.updateContact(phoneId, contact.id, {
      name: contact.name, numbers: contact.numbers, group: contact.group,
      trusted: contact.trusted, isUser: contact.isUser,
      ...(pin ? { pin } : { clearPin: true }),
    });
    if (state.selectedPhone?.id === phoneId) await load(phoneId);
  } catch (err) {
    pinSaveError.value = (err as Error).message;
    error.value = pinSaveError.value;
  }
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
  <ContactForm v-if="formOpen" :contact="editing" :initial-number="newNumber" :busy="saving" :country-code="state.selectedPhone?.line.countryCode ?? '+61'" :error="error" @save="save" @cancel="formOpen = false; editing = null; newNumber = ''" />
  <div v-else-if="contacts.length" class="stack">
    <div class="row contact-filter-controls">
      <nav class="phone-chips contact-filters" aria-label="Filter contacts">
        <button type="button" class="phone-chip" :class="{ active: contactFilter.kind === 'all' }" :aria-pressed="contactFilter.kind === 'all'" @click="contactFilter = { kind: 'all' }">All</button>
        <button type="button" class="phone-chip" :class="{ active: contactFilter.kind === 'trusted' }" :aria-pressed="contactFilter.kind === 'trusted'" @click="contactFilter = { kind: 'trusted' }">Trusted</button>
        <button type="button" class="phone-chip" :class="{ active: contactFilter.kind === 'you' }" :aria-pressed="contactFilter.kind === 'you'" @click="contactFilter = { kind: 'you' }">You</button>
        <button v-for="group in groups" :key="group" type="button" class="phone-chip" :class="{ active: contactFilter.kind === 'group' && contactFilter.group.toLocaleLowerCase() === group.toLocaleLowerCase() }" :aria-pressed="contactFilter.kind === 'group' && contactFilter.group === group" @click="contactFilter = { kind: 'group', group }">{{ group }}</button>
      </nav>
      <label class="field contact-search">
        <span class="visually-hidden">Search contacts</span>
        <input v-model="contactSearch" type="search" aria-label="Search contacts" placeholder="Search people">
      </label>
    </div>
    <ContactList :contacts="visibleContacts" :all-contact-count="contacts.length" :busy="saving || loading" @edit="editing = $event; formOpen = true" @remove="remove">
    <template #actions="{ contact }">
      <Button v-if="contact.isUser || contact.trusted" :label="pinOpenId === contact.id ? 'Hide PIN' : 'Caller PIN'" severity="secondary" :aria-expanded="pinOpenId === contact.id" :aria-label="`Caller PIN for ${contact.name}`" @click="pinOpenId = pinOpenId === contact.id ? null : contact.id" />
    </template>
    <template #details="{ contact }">
      <PinEditor v-if="pinOpenId === contact.id" :contact="contact" :busy="saving || loading" :line-number="state.selectedPhone?.line.localNumber" :server-error="pinSaveError" @save="savePin(contact, $event)" />
    </template>
    </ContactList>
  </div>
  <ContactList v-else :contacts="contacts" :busy="saving || loading" @edit="editing = $event; formOpen = true" @remove="remove" />
</template>

<style scoped>
.contact-filter-controls { justify-content: space-between; }
.contact-filters { flex: 1 1 auto; }
.contact-search { flex: 0 1 20rem; }
</style>
