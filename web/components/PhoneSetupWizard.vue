<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { api, type DongleInventoryResult, type LlmConfig, type PairingStatus, type PhoneEntry, type TimbreConfig, type UsbDongle } from '../api';
import AppSelect from './AppSelect.vue';
import { useThemeOverlayProps } from '../theme-overlay';

const props = defineProps<{
  visible: boolean;
  config: TimbreConfig | null;
  llms: LlmConfig[];
  error: string;
  createDraft: () => Promise<PhoneEntry | null>;
  saveDraft: () => Promise<boolean>;
  discardDraft: (phoneId: string) => Promise<void>;
  pairAgainPhoneId?: string | null;
}>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();

const overlayProps = useThemeOverlayProps();
const step = ref(1);
const loadingDongles = ref(false);
const creatingPhone = ref(false);
const busyPairing = ref(false);
const dongles = ref<UsbDongle[]>([]);
const probeError = ref('');
const localError = ref('');
const selectedId = ref('');
const scoChannels = ref(2);
const executable = ref('');
const phone = ref<PhoneEntry | null>(null);
const pairing = ref<PairingStatus | null>(null);
const phoneName = ref('');
const llmId = ref('');
const voice = ref<'auto' | 'piper' | 'sapi' | 'none'>('auto');
const piperModel = ref('');
const sttModel = ref('');
let pollTimer: ReturnType<typeof setInterval> | undefined;
let polling = false;

const selectedDongle = computed(() => dongles.value.find((dongle) => dongle.id === selectedId.value));
const readyDongle = computed(() => {
  const dongle = selectedDongle.value;
  if (!dongle || dongle.inUseBy || !dongle.probeAvailable) return false;
  return dongle.driver === 'libusbK' || dongle.driver === 'not-applicable';
});
const errorMessage = computed(() => localError.value || props.error);
const canAdvance = computed(() => !!readyDongle.value && !!executable.value.trim() && !loadingDongles.value && !creatingPhone.value);
const isPairAgain = computed(() => !!props.pairAgainPhoneId);

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  polling = false;
}

function reset() {
  stopPolling();
  step.value = 1;
  loadingDongles.value = false;
  creatingPhone.value = false;
  busyPairing.value = false;
  dongles.value = [];
  probeError.value = '';
  localError.value = '';
  selectedId.value = '';
  scoChannels.value = 2;
  executable.value = props.config?.phones.find((item) => item.line.executable.trim())?.line.executable ?? '';
  phone.value = null;
  pairing.value = null;
  phoneName.value = '';
  llmId.value = props.llms[0]?.id ?? '';
  voice.value = 'auto';
  piperModel.value = '';
  sttModel.value = '';
}

async function loadDongles() {
  loadingDongles.value = true;
  localError.value = '';
  try {
    const result: DongleInventoryResult = await api.phoneDongles(executable.value.trim() || undefined);
    dongles.value = result.dongles;
    probeError.value = result.probeError ?? '';
  } catch (err) { localError.value = (err as Error).message; }
  finally { loadingDongles.value = false; }
}

function adoptPhone(id: string) {
  phone.value = props.config?.phones.find((candidate) => candidate.id === id) ?? phone.value;
}

async function pairAgain(phoneId: string) {
  const existing = props.config?.phones.find((candidate) => candidate.id === phoneId);
  if (!existing) { localError.value = 'That phone is no longer available.'; return; }
  phone.value = existing;
  phoneName.value = existing.name;
  llmId.value = existing.llmId;
  voice.value = existing.line.voice.tts;
  piperModel.value = existing.line.voice.piperModel;
  sttModel.value = existing.line.voice.sttModel;
  step.value = 2;
  await startPairing();
}

async function continueWithDongle() {
  const dongle = selectedDongle.value;
  if (!dongle || !readyDongle.value) return;
  localError.value = '';
  creatingPhone.value = true;
  try {
    const created = await props.createDraft();
    if (!created) { localError.value = props.error || 'Could not create the phone.'; return; }
    phone.value = props.config?.phones.find((candidate) => candidate.id === created.id) ?? created;
    phone.value.line.enabled = true;
    phone.value.line.executable = executable.value.trim();
    phone.value.line.transport = `usb:${dongle.id}+sco=${scoChannels.value}`;
    await nextTick();
    const id = phone.value.id;
    if (!await props.saveDraft()) {
      await props.discardDraft(id);
      phone.value = null;
      localError.value = props.error || 'Could not save the dongle settings.';
      return;
    }
    await nextTick();
    adoptPhone(id);
    step.value = 2;
    await startPairing();
  } catch (err) { localError.value = (err as Error).message; }
  finally { creatingPhone.value = false; }
}

function acceptPairingState(status: PairingStatus) {
  const previousState = pairing.value?.state;
  pairing.value = status;
  if (previousState && previousState !== status.state) localError.value = '';
  if (status.state === 'pairing') step.value = 2;
  if (status.state === 'paired') {
    stopPolling();
    step.value = 4;
    if (status.phone?.name && phoneName.value === '') phoneName.value = status.phone.name;
  }
  if (status.state === 'failed' || status.state === 'expired' || status.state === 'rejected' || status.state === 'cancelled') {
    stopPolling();
    step.value = 2;
  }
}

async function pollPairing() {
  if (polling || !phone.value) return;
  polling = true;
  try { acceptPairingState(await api.pairingStatus(phone.value.id)); }
  catch (err) { localError.value = (err as Error).message; stopPolling(); }
  finally { polling = false; }
}

async function startPairing() {
  if (!phone.value) return;
  localError.value = '';
  busyPairing.value = true;
  try {
    acceptPairingState(await api.startPairing(phone.value.id, 180));
    stopPolling();
    pollTimer = setInterval(() => { void pollPairing(); }, 1000);
  } catch (err) { localError.value = (err as Error).message; }
  finally { busyPairing.value = false; }
}

async function confirmPairing(accept: boolean) {
  const current = pairing.value;
  if (!phone.value || !current?.pairingId || !current.phone?.address || !current.numericCode) return;
  busyPairing.value = true;
  localError.value = '';
  try {
    const result = await api.confirmPairing(phone.value.id, {
      pairingId: current.pairingId,
      address: current.phone.address,
      numericCode: current.numericCode,
      accept,
    });
    acceptPairingState(result);
  } catch (err) { localError.value = (err as Error).message; }
  finally { busyPairing.value = false; }
}

async function cancelActivePairing() {
  stopPolling();
  const current = pairing.value;
  const id = phone.value?.id;
  if (id && current?.pairingId && ['discoverable', 'awaiting-confirmation', 'pairing'].includes(current.state)) {
    try { await api.cancelPairing(id, current.pairingId); } catch { /* The setup can still close if telefony has stopped. */ }
  }
}

async function goBack() {
  if (step.value !== 2) { step.value -= 1; return; }
  await cancelActivePairing();
  if (isPairAgain.value) {
    phone.value = null;
    pairing.value = null;
    emit('update:visible', false);
    return;
  }
  if (phone.value) await props.discardDraft(phone.value.id);
  phone.value = null;
  pairing.value = null;
  localError.value = '';
  step.value = 1;
  await nextTick();
  await loadDongles();
}

async function cancelSetup() {
  await cancelActivePairing();
  if (phone.value && !isPairAgain.value) await props.discardDraft(phone.value.id);
  phone.value = null;
  pairing.value = null;
  emit('update:visible', false);
}

async function finishSetup() {
  if (!phone.value) return;
  phone.value.name = phoneName.value.trim() || 'Phone';
  phone.value.llmId = llmId.value;
  phone.value.line.voice.tts = voice.value;
  phone.value.line.voice.piperModel = piperModel.value.trim();
  phone.value.line.voice.sttModel = sttModel.value.trim();
  if (!await props.saveDraft()) {
    localError.value = props.error || 'Could not save the phone settings.';
    return;
  }
  phone.value = null;
  emit('update:visible', false);
}

watch(() => props.visible, (visible) => {
  if (!visible) { stopPolling(); return; }
  reset();
  if (props.pairAgainPhoneId) void pairAgain(props.pairAgainPhoneId);
  else void loadDongles();
}, { immediate: true });

watch(() => props.config?.phones, () => {
  if (phone.value) adoptPhone(phone.value.id);
}, { deep: false });

onUnmounted(stopPolling);
</script>

<template>
  <Dialog v-bind="overlayProps" :visible="visible" modal :closable="false" :draggable="false" class="phone-setup-dialog" :header="isPairAgain ? 'Pair again' : 'Set up a phone'" @update:visible="$emit('update:visible', $event)">
    <div class="setup-steps" aria-label="Setup steps">
      <span v-for="(label, index) in ['Dongle', 'Find phone', 'Confirm code', 'Settings']" :key="label" class="pill" :class="step === index + 1 ? 'sky' : 'sample-label'">{{ index + 1 }}. {{ label }}</span>
    </div>

    <section v-if="step === 1" class="setup-body stack">
      <div>
        <h2>Choose a Bluetooth dongle</h2>
        <p class="muted">Timbre checks the USB ID and driver. A phone already assigned to another line is unavailable.</p>
      </div>
      <p v-if="loadingDongles" class="muted" role="status">Checking connected USB devices…</p>
      <p v-else-if="dongles.length === 0" class="muted">No Bluetooth dongles found. Connect a USB dongle and scan again.</p>
      <div v-else class="dongle-list" role="radiogroup" aria-label="Bluetooth dongle">
        <label v-for="dongle in dongles" :key="dongle.id" class="dongle-card" :class="{ selected: selectedId === dongle.id, disabled: !!dongle.inUseBy }">
          <input v-model="selectedId" type="radio" name="phone-dongle" :value="dongle.id" :disabled="!!dongle.inUseBy" />
          <span class="dongle-copy"><strong>{{ dongle.name }}</strong><small>{{ dongle.id }} · {{ dongle.driver }}{{ dongle.probeAvailable ? ' · probe ready' : ' · probe unavailable' }}</small>
            <small v-if="dongle.inUseBy">In use by {{ dongle.inUseBy }}</small></span>
        </label>
      </div>
      <p v-if="probeError" class="muted small">Probe note: {{ probeError }}</p>
      <p v-if="selectedDongle && selectedDongle.driver === 'other'" class="setup-note">Bind this dongle to libusbK in <a href="https://github.com/PetePeter/telefony-app/blob/main/SETUP.md#4--human-bind-the-dongle-to-libusbk-with-zadig" target="_blank" rel="noreferrer">Zadig</a>, then scan again.</p>
      <p v-else-if="selectedDongle && selectedDongle.driver === 'unknown'" class="setup-note">Windows could not verify the driver. Check it in Device Manager or run the Zadig steps in the <a href="https://github.com/PetePeter/telefony-app/blob/main/SETUP.md#4--human-bind-the-dongle-to-libusbk-with-zadig" target="_blank" rel="noreferrer">setup guide</a>.</p>
      <div class="grid2">
        <label class="field"><span>Telefony app executable</span><InputText v-model="executable" placeholder="…/.venv/Scripts/telefony-app.exe" /></label>
        <label class="field"><span>SCO audio channels</span>
          <AppSelect v-model="scoChannels" :options="[{ label: '1 channel', value: 1 }, { label: '2 channels (stereo)', value: 2 }]" option-label="label" option-value="value" aria-label="SCO audio channels" />
        </label>
      </div>
      <Button label="Scan again" severity="secondary" :disabled="loadingDongles" @click="loadDongles" />
    </section>

    <section v-else-if="step === 2" class="setup-body stack">
      <div>
        <h2>{{ isPairAgain ? 'Pair the existing phone' : 'Find the phone' }}</h2>
        <p v-if="isPairAgain" class="muted">This reuses {{ phone?.name }} and its current Bluetooth dongle. It will not add another line.</p>
        <p v-else class="muted">On the phone, open Bluetooth settings and choose <strong>telefony</strong>. Keep this window open while pairing.</p>
      </div>
      <p v-if="pairing?.state === 'discoverable'" class="pill sky" role="status">Ready to pair · expires {{ pairing.expiresAt }}</p>
      <p v-else-if="pairing?.state === 'pairing'" class="pill sky" role="status">Pairing {{ pairing.phone?.name || 'phone' }}… waiting for Bluetooth to finish.</p>
      <p v-else-if="pairing?.state === 'failed' || pairing?.state === 'expired' || pairing?.state === 'rejected' || pairing?.state === 'cancelled'" class="pill rose">{{ pairing.error?.message || `Pairing ${pairing.state}. Start again when ready.` }}</p>
      <button v-if="pairing?.state === 'awaiting-confirmation'" class="detected-phone" type="button" @click="step = 3">
        <span class="pill sky">Phone detected · tap to pair</span>
        <strong>{{ pairing.phone?.name || 'Bluetooth phone' }}</strong>
        <small>{{ pairing.phone?.address }}</small>
      </button>
      <Button v-if="!pairing || ['failed', 'expired', 'rejected', 'cancelled'].includes(pairing.state)" label="Start discovery" :loading="busyPairing" :disabled="busyPairing" @click="startPairing" />
      <Button v-else-if="pairing.state === 'paired'" label="Continue" @click="step = 4" />
    </section>

    <section v-else-if="step === 3" class="setup-body stack">
      <div>
        <h2>Confirm the pairing code</h2>
        <p class="muted">Compare this number with the one shown on your phone. Confirm only if they match.</p>
      </div>
      <p class="pairing-code" aria-label="Pairing code">{{ pairing?.numericCode || '------' }}</p>
      <p class="muted">{{ pairing?.phone?.name || 'Phone' }} · {{ pairing?.phone?.address }}</p>
      <div class="row">
        <Button label="Reject" severity="secondary" :disabled="busyPairing" @click="confirmPairing(false)" />
        <Button label="Codes match" :loading="busyPairing" :disabled="busyPairing || !pairing?.numericCode" @click="confirmPairing(true)" />
      </div>
    </section>

    <section v-else class="setup-body stack">
      <div>
        <h2>Phone settings</h2>
        <p class="muted">The pairing is saved. Set how this line appears in Timbre and how it speaks.</p>
      </div>
      <div class="grid2">
        <label class="field"><span>Phone name</span><InputText v-model="phoneName" placeholder="Work phone" /></label>
        <label class="field"><span>Answered by</span>
          <AppSelect v-model="llmId" :options="llms" option-label="name" option-value="id" aria-label="Answered by" />
        </label>
        <label class="field"><span>Voice</span>
          <AppSelect v-model="voice" :options="[{ label: 'Auto', value: 'auto' }, { label: 'Piper', value: 'piper' }, { label: 'Windows SAPI', value: 'sapi' }, { label: 'None', value: 'none' }]" option-label="label" option-value="value" aria-label="Voice" />
        </label>
        <label v-if="voice === 'piper'" class="field"><span>Piper model path</span><InputText v-model="piperModel" placeholder="models/en_GB-alan-medium.onnx" /></label>
        <label class="field"><span>Speech recognition model</span><InputText v-model="sttModel" placeholder="small.en" /></label>
      </div>
      <p class="muted">Manage allowed callers and groups on the <a href="/access" target="_blank" rel="noreferrer">Access page</a>.</p>
      <p class="muted small">Bluetooth transport: {{ phone?.line.transport }}</p>
    </section>

    <p v-if="errorMessage" class="error-banner" role="alert">{{ errorMessage }}</p>
    <template #footer>
      <div class="row setup-footer">
        <Button label="Cancel setup" severity="secondary" :disabled="creatingPhone || busyPairing" @click="cancelSetup" />
        <span class="grow" />
        <Button v-if="step > 1 && step < 4" label="Back" severity="secondary" :disabled="busyPairing" @click="goBack" />
        <Button v-if="step === 1" label="Continue" :disabled="!canAdvance" :loading="creatingPhone" @click="continueWithDongle" />
        <Button v-if="step === 4" label="Finish setup" :disabled="busyPairing || !phone" @click="finishSetup" />
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.setup-steps { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 18px; }
.setup-body { min-height: 250px; }
.dongle-list { display: grid; gap: 9px; }
.dongle-card { display: flex; gap: 11px; align-items: flex-start; padding: 12px; border: 1px solid var(--line); border-radius: 12px; cursor: pointer; }
.dongle-card.selected { border-color: var(--brand); background: var(--brand-soft); }
.dongle-card.disabled { opacity: .58; cursor: default; }
.dongle-copy { display: grid; gap: 3px; min-width: 0; }
.dongle-copy small { color: var(--muted); overflow-wrap: anywhere; }
.setup-note { padding: 10px 12px; border-radius: 12px; background: var(--coral-soft); color: var(--coral-ink); }
.detected-phone { display: grid; gap: 6px; justify-items: start; padding: 15px; border: 1px solid var(--brand); border-radius: 14px; background: var(--brand-soft); color: var(--text); text-align: left; }
.detected-phone small { color: var(--muted); }
.pairing-code { font: 700 38px/1.2 var(--mono); letter-spacing: .16em; text-align: center; padding: 22px; background: var(--soft); border-radius: 14px; }
.setup-footer { width: 100%; }
</style>
