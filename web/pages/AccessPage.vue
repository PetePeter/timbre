<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import ToggleSwitch from 'primevue/toggleswitch';
import InputText from 'primevue/inputtext';
import InboundRuleEditor from '../components/InboundRuleEditor.vue';
import InboundHandlingEditor from '../components/InboundHandlingEditor.vue';
import ScheduleEditor from '../components/ScheduleEditor.vue';
import SpamScoringEditor from '../components/SpamScoringEditor.vue';
import { api, type AddressBookContact, type InboundRule } from '../api';
import { useAppState } from '../app-state';
import { patternToRegex } from '../../src/phone/phone-config.js';
import { isClockTime, isTimeZone } from '../../src/phone/schedule.js';

const state = useAppState();
const contacts = ref<AddressBookContact[]>([]);
const loading = ref(false);
const error = ref('');
let loadSequence = 0;

const scheduleError = computed(() => {
  const schedule = state.selectedPhone?.line.schedule;
  if (!schedule) return '';
  if (!isTimeZone(schedule.timeZone)) return 'Enter a valid IANA time zone, such as Australia/Sydney.';
  if (schedule.slots.some((slot) => !slot.days.length || !isClockTime(slot.start) || !isClockTime(slot.end) || slot.start === slot.end)) {
    return 'Each schedule slot needs at least one day and different start and end times.';
  }
  return '';
});

const blockRules = computed<InboundRule[]>({
  get: () => state.selectedPhone?.line.screening.block ?? [],
  set: (next) => {
    const phone = state.selectedPhone;
    if (!phone) return;
    const current = phone.line.screening.block;
    const removed = current.filter((rule) => !next.some((candidate) => candidate.kind === rule.kind && candidate.value === rule.value));
    if (removed.length) {
      const legacyPatterns = new Set(removed.flatMap((rule) => {
        const numbers = rule.kind === 'number'
          ? [rule.value]
          : contacts.value.filter((contact) => rule.kind === 'contact'
            ? contact.id === rule.value
            : contact.group.trim().toLocaleLowerCase() === rule.value.trim().toLocaleLowerCase())
            .flatMap((contact) => contact.numbers);
        return numbers.map((number) => patternToRegex(number, phone.line.countryCode))
          .filter((pattern): pattern is string => pattern !== null);
      }));
      phone.line.blocklist = phone.line.blocklist.filter((pattern) => !legacyPatterns.has(pattern));
      phone.line.contactRules = phone.line.contactRules.filter((policy) => policy.role !== 'blocked' || !removed.some((rule) => {
        if (rule.kind === 'contact') return policy.contactId === rule.value;
        if (rule.kind === 'group') {
          return contacts.value.some((contact) => contact.id === policy.contactId
            && contact.group.trim().toLocaleLowerCase() === rule.value.trim().toLocaleLowerCase());
        }
        if (typeof policy.pattern !== 'string') return false;
        const policyPattern = patternToRegex(policy.pattern, phone.line.countryCode);
        return policyPattern !== null && policyPattern === patternToRegex(rule.value, phone.line.countryCode);
      }));
    }
    phone.line.screening.block = next;
  },
});

async function load(phoneId: string | undefined) {
  const sequence = ++loadSequence;
  contacts.value = [];
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

async function save() {
  error.value = '';
  await state.save();
  if (state.error) error.value = state.error;
}
</script>

<template>
  <div class="page-heading">
    <div><h1>Call access</h1><p>Choose who can reach {{ state.selectedPhone?.name ?? 'this phone' }}’s agent.</p></div>
  </div>
  <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
  <p v-if="loading" class="muted" role="status">Loading contacts…</p>
  <template v-if="state.selectedPhone">
    <section class="panel access-card">
      <div class="section-heading">
        <div><h2>Private and withheld numbers</h2><p class="muted">Accepted private callers enter Reception and are not sent to the agent.</p></div>
        <ToggleSwitch v-model="state.selectedPhone.line.screening.acceptPrivate" input-id="accept-private" aria-label="Accept private numbers" :disabled="state.busy" />
      </div>
    </section>
    <section class="panel access-card">
      <h2>Allow list</h2>
      <p class="muted">When this list has entries, only matching callers can reach the agent.</p>
      <InboundRuleEditor v-model="state.selectedPhone.line.screening.allow" :contacts="contacts" aria-label="Allow list" add-label="Add to allow list" :disabled="state.busy || loading" />
    </section>
    <section class="panel access-card">
      <h2>Block list</h2>
      <p class="muted">Blocked callers are rejected before the agent answers.</p>
      <InboundRuleEditor v-model="blockRules" :contacts="contacts" aria-label="Block list" add-label="Add to block list" :disabled="state.busy || loading" />
    </section>
    <section class="panel access-card">
      <h2>Spam scoring</h2>
      <p class="muted">Unknown callers are scored from recent call history. Two agent spam flags block the next call; adding a caller to the allow list overrides the score.</p>
      <SpamScoringEditor v-model="state.selectedPhone.line.spam" :disabled="state.busy" />
    </section>
    <section class="panel access-card">
      <h2>Caller handling</h2>
      <p class="muted">After access checks, choose the default call path, SMS reply mode, and contact or group overrides.</p>
      <label class="field local-number-field">
        <span>Connected SIM number</span>
        <InputText v-model="state.selectedPhone.line.localNumber" aria-label="Connected SIM number" placeholder="+61491570156" :disabled="state.busy || loading" />
        <small class="muted">Required for SMS auto-replies; this number, short codes, and alphanumeric sender IDs are never reply targets.</small>
      </label>
      <InboundHandlingEditor v-model="state.selectedPhone.line.inboundHandling" :contacts="contacts" :disabled="state.busy || loading" />
    </section>
    <section class="panel access-card">
      <h2>Weekly schedule</h2>
      <p class="muted">Active slots supply call handling, greetings, and SMS reply modes unless a contact or group rule overrides them.</p>
      <ScheduleEditor v-model="state.selectedPhone.line.schedule" :disabled="state.busy || loading" />
      <p v-if="scheduleError" class="error-banner" role="alert">{{ scheduleError }}</p>
    </section>
    <div class="access-footer">
      <span class="muted">{{ state.dirty ? 'Unsaved changes' : 'All changes saved' }}</span>
      <Button label="Save access settings" aria-label="Save access settings" :disabled="!state.dirty || state.busy || Boolean(scheduleError)" :loading="state.busy" @click="save" />
    </div>
  </template>
  <section v-else class="panel empty-state"><h2>No phone selected</h2></section>
</template>

<style scoped>
.access-card { margin-bottom: 16px; }
.access-card h2 { margin: 0 0 6px; }
.access-card > .muted { margin: 0; }
.local-number-field { display: grid; gap: 6px; max-width: 560px; margin-top: 16px; }
.local-number-field > span { color: var(--muted); font-size: .9rem; }
.section-heading { align-items: center; gap: 20px; }
.section-heading h2 { margin: 0 0 6px; }
.access-footer { display: flex; align-items: center; justify-content: flex-end; gap: 14px; margin: 22px 0 40px; }
@media (max-width: 640px) { .access-footer { justify-content: space-between; } }
</style>
