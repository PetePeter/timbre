<script setup lang="ts">
import { ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import ToggleSwitch from 'primevue/toggleswitch';
import type { AddressBookContact, AddressBookContactInput } from '../api';

const props = defineProps<{ contact: AddressBookContact | null; busy: boolean }>();
const emit = defineEmits<{ save: [contact: AddressBookContactInput]; cancel: [] }>();
const name = ref('');
const numbers = ref('');
const group = ref('');
const trusted = ref(false);
const isUser = ref(false);

watch(() => props.contact, (contact) => {
  name.value = contact?.name ?? '';
  numbers.value = contact?.numbers.join('\n') ?? '';
  group.value = contact?.group ?? '';
  trusted.value = contact?.trusted ?? false;
  isUser.value = contact?.isUser ?? false;
}, { immediate: true });

function submit() {
  emit('save', { name: name.value, numbers: numbers.value.split(/\r?\n/).map((number) => number.trim()).filter(Boolean), group: group.value, trusted: trusted.value, isUser: isUser.value });
}
</script>

<template>
  <form class="panel stack contact-form" aria-label="Contact details" @submit.prevent="submit">
    <h2>{{ contact ? 'Edit contact' : 'Add contact' }}</h2>
    <label class="field"><span>Name</span><InputText v-model="name" aria-label="Name" autocomplete="name" required :disabled="busy" /></label>
    <label class="field"><span>Phone numbers</span><textarea v-model="numbers" class="p-inputtext" aria-label="Phone numbers" rows="3" placeholder="One number per line" required :disabled="busy" /></label>
    <label class="field"><span>Group</span><InputText v-model="group" aria-label="Group" placeholder="Family, work, …" :disabled="busy" /></label>
    <label class="control-row" for="contact-trusted"><span>Trusted</span><ToggleSwitch v-model="trusted" input-id="contact-trusted" aria-label="Trusted" :disabled="busy" /></label>
    <label class="control-row" for="contact-user"><span>This is me</span><ToggleSwitch v-model="isUser" input-id="contact-user" aria-label="User" :disabled="busy" /></label>
    <div class="row">
      <Button type="submit" label="Save contact" aria-label="Save contact" :loading="busy" />
      <Button type="button" label="Cancel" severity="secondary" :disabled="busy" @click="emit('cancel')" />
    </div>
  </form>
</template>

<style scoped>
.contact-form { max-width: 640px; }
.contact-form textarea { resize: vertical; }
</style>
