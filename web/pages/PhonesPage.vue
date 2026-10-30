<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import PhonePanel from '../PhonePanel.vue';
import PhoneSetupWizard from '../components/PhoneSetupWizard.vue';
import { api, type PhoneEntry } from '../api';
import { useAppState } from '../app-state';
const state = useAppState();
const route = useRoute();
const router = useRouter();
const setupVisible = ref(false);
const pairAgainPhoneId = ref<string | null>(null);
const canPairAgain = computed(() => {
  const transport = state.selectedPhone?.line.transport ?? '';
  return transport.startsWith('usb:') && !!state.cfg?.telefony.executable.trim();
});

watch(() => [route.query.setup, state.cfg] as const, ([setup, config]) => {
  if (setup !== '1' || !config || setupVisible.value) return;
  addPhone();
  const query = { ...route.query };
  delete query.setup;
  void router.replace({ path: route.path, query });
}, { immediate: true });

function addPhone() {
  pairAgainPhoneId.value = null;
  setupVisible.value = true;
}

function pairAgain() {
  if (!state.selectedPhone) return;
  pairAgainPhoneId.value = state.selectedPhone.id;
  setupVisible.value = true;
}

async function createDraft(): Promise<PhoneEntry | null> {
  let created: PhoneEntry | null = null;
  await state.run(async () => {
    if (state.dirty && state.cfg) state.adopt(await api.save(state.cfg));
    const next = await api.addPhone();
    state.adopt(next);
    created = next.phones.at(-1) ?? null;
    if (created) state.selectedId = created.id;
  });
  return created;
}

async function saveDraft(): Promise<boolean> {
  let saved = false;
  await state.run(async () => {
    if (!state.cfg) return;
    state.adopt(await api.save(state.cfg));
    saved = true;
  });
  return saved;
}

async function discardDraft(phoneId: string): Promise<void> {
  await state.run(async () => {
    state.adopt(await api.removePhone(phoneId));
    if (state.selectedId === phoneId) state.selectedId = state.cfg?.phones[0]?.id ?? '';
  });
}
</script>
<template>
  <div class="page-heading"><div><h1>Phones</h1><p>The mobiles connected to Timbre, each with its own line.</p></div><div class="row"><Button v-if="canPairAgain" label="Pair again" severity="secondary" :disabled="state.busy" @click="pairAgain" /><Button v-if="state.cfg?.phones.length" label="+ Add phone" :disabled="state.busy" @click="addPhone" /></div></div>
  <PhonePanel v-if="state.cfg && state.selectedPhone" :key="state.selectedPhone.id" :phone="state.selectedPhone" :llms="state.cfg.llms" :status="state.selectedStatus" :busy="state.busy" :dirty="state.dirty" @remove="state.removePhone(state.selectedPhone!.id)" @run="state.run" />
  <section v-else-if="state.cfg" class="panel empty-state phone-empty">
    <div class="empty-icon" aria-hidden="true">☎</div>
    <h2>No phones connected</h2>
    <p>Add a phone to configure its line and connect a Bluetooth dongle.</p>
    <Button label="Set up a phone" :disabled="state.busy" @click="addPhone" />
  </section>
  <PhoneSetupWizard v-model:visible="setupVisible" :config="state.cfg" :llms="state.cfg?.llms ?? []" :error="state.error" :create-draft="createDraft" :save-draft="saveDraft" :discard-draft="discardDraft" :pair-again-phone-id="pairAgainPhoneId" />
</template>
