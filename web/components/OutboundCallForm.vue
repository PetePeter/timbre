<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api, type CallSkill } from '../api';
import Button from 'primevue/button';
import FormField from './FormField.vue';
import ContactNumberInput from './ContactNumberInput.vue';
import OwnerSmsForm from './OwnerSmsForm.vue';
import { callDestinationError, callTaskError } from '../field-validation';
import { matchContactsByNumber } from '../../src/contacts/match-number.js';
import type { AddressBookContact } from '../../src/contacts/contact.js';

type ActionTab = 'call' | 'sms';

const phones = ref<Array<{ id: string; name: string; countryCode: string }>>([]);
const phoneId = ref('');
const to = ref('');
const task = ref('');
const callSkills = ref<CallSkill[]>([]);
const selectedSkillId = ref('');
const skillParams = ref<Record<string, string>>({});
const loadingPhones = ref(true);
const busy = ref(false);
const error = ref('');
const interactionId = ref('');
const attempted = ref(false);
const contacts = ref<AddressBookContact[]>([]);
const activeTab = ref<ActionTab>('call');
const callTab = ref<HTMLButtonElement | null>(null);
const smsTab = ref<HTMLButtonElement | null>(null);
const selectedPhone = computed(() => phones.value.find((phone) => phone.id === phoneId.value));
const selectedSkill = computed(() => callSkills.value.find((skill) => skill.id === selectedSkillId.value));
const matchedName = computed(() => matchContactsByNumber(contacts.value, to.value, to.value.trim())[0]?.name ?? '');

watch(selectedSkillId, (id) => {
  const skill = callSkills.value.find((item) => item.id === id);
  skillParams.value = skill?.defaultNumber ? { number: skill.defaultNumber } : {};
});

watch(phoneId, async (id) => {
  contacts.value = [];
  if (!id) return;
  try { contacts.value = await api.contacts(id); } catch { /* the name hint is optional */ }
});

onMounted(async () => {
  try {
    const [status, config] = await Promise.all([api.status(), api.config().catch(() => null)]);
    const countryCodes = new Map(config?.phones.map((phone) => [phone.id, phone.line.countryCode]) ?? []);
    phones.value = status.phones.map(({ id, name }) => ({ id, name, countryCode: countryCodes.get(id) ?? '+61' }));
    phoneId.value = phones.value[0]?.id ?? '';
    callSkills.value = config?.callSkills ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingPhones.value = false;
  }
});

async function submit(): Promise<void> {
  attempted.value = true;
  const skill = selectedSkill.value;
  if (!phoneId.value) return;
  if (skill) {
    const missing = skill.fields.some((field) => (field.required || (field.key === 'number' && !skill.defaultNumber))
      && !skillParams.value[field.key]?.trim());
    if (missing) return;
  } else if (callDestinationError(to.value) || callTaskError(task.value)) return;
  busy.value = true;
  error.value = '';
  interactionId.value = '';
  try {
    const request = skill
      ? { skillId: skill.id, params: skillParams.value }
      : { to: to.value, task: task.value };
    const result = await api.createCall(phoneId.value, request);
    interactionId.value = result.interactionId;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function onTabKeydown(tab: ActionTab, event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next: ActionTab = event.key === 'Home' ? 'call'
    : event.key === 'End' ? 'sms'
      : tab === 'call' ? 'sms' : 'call';
  activeTab.value = next;
  (next === 'call' ? callTab : smsTab).value?.focus();
}
</script>

<template>
  <section class="panel stack" aria-labelledby="call-for-me-title" :aria-busy="loadingPhones || busy">
    <div>
      <h2 id="call-for-me-title">Call for me</h2>
      <p class="muted">Ask the call agent to handle a call on your behalf.</p>
    </div>
    <p v-if="loadingPhones" class="muted">Loading phone lines…</p>
    <template v-else>
      <label v-if="phones.length > 1" class="field">
        <span>Phone line</span>
        <FormField v-slot="{ inputAttrs }" :value="phoneId" hint="Choose the phone line to use." :attempted="attempted" :block-save="false">
          <select v-model="phoneId" v-bind="inputAttrs" name="phoneId" required>
            <option v-for="phone in phones" :key="phone.id" :value="phone.id">{{ phone.name }}</option>
          </select>
        </FormField>
      </label>
      <div class="action-tabs" role="tablist" aria-label="Call actions">
        <button
          id="call-for-me-call-tab" ref="callTab" type="button" role="tab" aria-controls="call-panel"
          :aria-selected="activeTab === 'call'" :tabindex="activeTab === 'call' ? 0 : -1"
          @click="activeTab = 'call'" @keydown="onTabKeydown('call', $event)"
        >Call</button>
        <button
          id="call-for-me-sms-tab" ref="smsTab" type="button" role="tab" aria-controls="sms-panel"
          :aria-selected="activeTab === 'sms'" :tabindex="activeTab === 'sms' ? 0 : -1"
          @click="activeTab = 'sms'" @keydown="onTabKeydown('sms', $event)"
        >SMS</button>
      </div>
      <div id="call-panel" class="stack" role="tabpanel" aria-labelledby="call-for-me-call-tab" tabindex="0" v-show="activeTab === 'call'">
        <form class="stack" novalidate @submit.prevent="submit">
          <label class="field">
            <span>Call skill</span>
            <select v-model="selectedSkillId" name="callSkill">
              <option value="">Custom task</option>
              <option v-for="skill in callSkills" :key="skill.id" :value="skill.id">{{ skill.name }} — {{ skill.description }}</option>
            </select>
          </label>
          <template v-if="selectedSkill">
            <p class="muted">{{ selectedSkill.description }}</p>
            <label v-for="field in selectedSkill.fields" :key="field.key" class="field">
              <span>{{ field.label }}<template v-if="field.required || (field.key === 'number' && !selectedSkill.defaultNumber)"> *</template></span>
              <FormField
                v-slot="{ inputAttrs }" :value="skillParams[field.key] ?? ''"
                :hint="field.key === 'number' ? 'Enter a phone number or name.' : 'This value is passed as task data.'"
                :validate="(value) => (field.required || (field.key === 'number' && !selectedSkill?.defaultNumber)) && !String(value ?? '').trim() ? `${field.label} is required.` : null"
                :attempted="attempted" :block-save="false"
              >
                <input v-model="skillParams[field.key]" v-bind="inputAttrs" :name="field.key" :type="field.key === 'number' ? 'tel' : 'text'" :maxlength="field.key === 'number' ? 120 : 1000" :required="field.required || (field.key === 'number' && !selectedSkill.defaultNumber)" />
              </FormField>
            </label>
          </template>
          <template v-else>
            <label class="field">
              <span>To</span>
              <FormField v-slot="{ inputAttrs }" :value="to" hint="Enter a contact name or destination (up to 120 characters)." :validate="callDestinationError" :attempted="attempted" :block-save="false"><ContactNumberInput v-model="to" v-bind="inputAttrs" :contacts="contacts" name="to" type="text" autocomplete="tel" minlength="1" maxlength="120" required /></FormField>
              <small v-if="matchedName" class="muted" role="status">{{ matchedName }}</small>
            </label>
            <label class="field">
              <span>Task</span>
              <FormField v-slot="{ inputAttrs }" :value="task" hint="Task must contain 1 to 4000 characters." :validate="callTaskError" :attempted="attempted" :block-save="false"><textarea v-model="task" v-bind="inputAttrs" name="task" rows="3" minlength="1" maxlength="4000" required /></FormField>
            </label>
          </template>
          <p v-if="phones.length === 0" class="muted">Add a phone line before requesting a call.</p>
          <Button type="submit" :label="busy ? 'Requesting…' : 'Call for me'" :disabled="busy || !phoneId" />
        </form>
      </div>
      <div id="sms-panel" class="stack" role="tabpanel" aria-labelledby="call-for-me-sms-tab" tabindex="0" v-show="activeTab === 'sms'">
        <OwnerSmsForm :active="activeTab === 'sms'" :phone-id="phoneId || null" :phone-name="selectedPhone?.name ?? 'Phone'" :country-code="selectedPhone?.countryCode ?? '+61'" />
      </div>
    </template>
    <p v-if="interactionId" role="status">Call requested. Interaction ID: <code>{{ interactionId }}</code></p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.field textarea { resize: vertical; }
.action-tabs { display: flex; width: fit-content; gap: 4px; padding: 4px; border-radius: 99px; background: var(--soft); }
.action-tabs button { border: 0; border-radius: 99px; background: transparent; color: var(--muted); cursor: pointer; font: inherit; font-size: 13px; font-weight: 650; padding: 7px 12px; }
.action-tabs button[aria-selected="true"] { background: var(--panel); color: var(--brand-ink); box-shadow: 0 1px 3px color-mix(in srgb, var(--text) 12%, transparent); }
.action-tabs button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
</style>
