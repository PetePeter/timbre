<script setup lang="ts">
import { ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import ToggleSwitch from 'primevue/toggleswitch';
import type { AddressBookContact, AddressBookContactInput, SummaryNotificationPreference } from '../api';

const props = defineProps<{ contact: AddressBookContact | null; busy: boolean }>();
const emit = defineEmits<{ save: [contact: AddressBookContactInput]; cancel: [] }>();
const name = ref('');
const numbers = ref('');
const group = ref('');
const trusted = ref(false);
const isUser = ref(false);
const summaryNotifications = ref<SummaryNotificationPreference[]>([]);
const summaryNotificationOptions: Array<{ value: SummaryNotificationPreference; label: string }> = [
  { value: 'all', label: 'All calls' },
  { value: 'missed', label: 'Missed calls' },
  { value: 'handed_over', label: 'Handed over' },
  { value: 'left_message', label: 'Left a message' },
];
let summaryNotificationsTouched = false;

watch(() => props.contact, (contact) => {
  name.value = contact?.name ?? '';
  numbers.value = contact?.numbers.join('\n') ?? '';
  group.value = contact?.group ?? '';
  trusted.value = contact?.trusted ?? false;
  isUser.value = contact?.isUser ?? false;
  summaryNotifications.value = [...(contact?.summaryNotifications ?? [])];
  summaryNotificationsTouched = false;
}, { immediate: true });

function submit() {
  const includeSummaryNotifications = isUser.value && (
    !props.contact || !props.contact.isUser || props.contact.summaryNotifications !== undefined || summaryNotificationsTouched
  );
  emit('save', {
    name: name.value,
    numbers: numbers.value.split(/\r?\n/).map((number) => number.trim()).filter(Boolean),
    group: group.value,
    trusted: trusted.value,
    isUser: isUser.value,
    ...(includeSummaryNotifications ? { summaryNotifications: [...summaryNotifications.value] } : {}),
  });
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
    <fieldset v-if="isUser" class="summary-notifications" :disabled="busy">
      <legend>Call summary texts</legend>
      <label v-for="option in summaryNotificationOptions" :key="option.value" class="control-row">
        <span>{{ option.label }}</span>
        <input v-model="summaryNotifications" type="checkbox" :value="option.value" :aria-label="option.label" @change="summaryNotificationsTouched = true" />
      </label>
    </fieldset>
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
