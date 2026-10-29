<script setup lang="ts">
import Button from 'primevue/button';
import type { AddressBookContact } from '../api';

defineProps<{ contacts: AddressBookContact[]; busy: boolean }>();
const emit = defineEmits<{ edit: [contact: AddressBookContact]; remove: [contact: AddressBookContact] }>();
</script>

<template>
  <div v-if="contacts.length" class="panel stack contact-list" aria-label="Contacts">
    <article v-for="contact in contacts" :key="contact.id" class="contact-row">
      <div class="contact-info">
        <h2>{{ contact.name }}</h2>
        <p v-if="contact.group" class="muted">{{ contact.group }}</p>
        <p v-for="number in contact.numbers" :key="number">{{ number }}</p>
        <div class="row">
          <span v-if="contact.trusted" class="pill sky">Trusted</span>
          <span v-if="contact.isUser" class="pill">You</span>
        </div>
      </div>
      <div class="row contact-actions">
        <Button label="Edit" severity="secondary" :aria-label="`Edit ${contact.name}`" :disabled="busy" @click="emit('edit', contact)" />
        <Button label="Delete" severity="danger" :aria-label="`Delete ${contact.name}`" :disabled="busy" @click="emit('remove', contact)" />
      </div>
    </article>
  </div>
  <section v-else class="panel empty-state">
    <h2>No contacts yet</h2>
    <p>Add the people this phone should know. Each phone keeps its own address book.</p>
  </section>
</template>

<style scoped>
.contact-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.contact-row:last-child { padding-bottom: 0; border: 0; }
.contact-info { min-width: 0; display: grid; gap: 3px; }
.contact-actions { flex-shrink: 0; }
@media (max-width: 640px) { .contact-row { align-items: flex-start; flex-direction: column; } }
</style>
