<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { api, type PhoneEntry, type TimbreConfig, type UsbDongle } from '../api';
import AppInputNumber from './AppInputNumber.vue';
import AppSelect from './AppSelect.vue';
import FormField from './FormField.vue';
import PhoneVoiceFields from './PhoneVoiceFields.vue';
import ServerFilePicker from './ServerFilePicker.vue';
import { phoneSetupExecutableError } from '../field-validation';
const props = withDefaults(defineProps<{
  config: TimbreConfig;
  phone: PhoneEntry;
  disabled?: boolean;
  idPrefix: string;
}>(), { disabled: false });

const dongles = ref<UsbDongle[]>([]);
const dongleError = ref('');
const loadingDongles = ref(false);
const scoChannels = ref(parseTransport(props.phone.line.transport)?.sco ?? 2);

const emit = defineEmits<{ deviceNameEdited: [] }>();

const line = computed(() => props.phone.line);

const selectedDongleId = computed({
  get: () => parseTransport(line.value.transport)?.id ?? '',
  set: (id: string) => {
    if (id) line.value.transport = `usb:${id}+sco=${scoChannels.value}`;
  },
});

const dongleOptions = computed(() => {
  const options = dongles.value.map((dongle) => ({
    label: `${dongle.name} (${dongle.id})${dongle.inUseBy && dongle.inUseBy !== props.phone.name ? ` · in use by ${dongle.inUseBy}` : ''}`,
    value: dongle.id,
    disabled: !usableDongle(dongle),
  }));
  const current = selectedDongleId.value;
  if (current && !options.some((option) => option.value === current)) options.unshift({ label: `Current controller (${current})`, value: current, disabled: false });
  return options;
});

function usableDongle(dongle: UsbDongle): boolean {
  return dongle.probeAvailable
    && ['WinUSB', 'libusbK', 'libusb0', 'not-applicable'].includes(dongle.driver)
    && (!dongle.inUseBy || dongle.inUseBy === props.phone.name);
}

function parseTransport(value: string): { id: string; sco: number } | null {
  const match = /^usb:([0-9a-f]{4}:[0-9a-f]{4})(?:\+sco=(\d+))?$/i.exec(value.trim());
  return match ? { id: `${match[1].slice(0, 4).toUpperCase()}:${match[1].slice(5).toUpperCase()}`, sco: Number(match[2]) || 2 } : null;
}

watch(() => line.value.transport, (value) => {
  const parsed = parseTransport(value);
  if (parsed) scoChannels.value = parsed.sco;
});

async function refreshDongles(): Promise<void> {
  loadingDongles.value = true;
  dongleError.value = '';
  try {
    const result = await api.phoneDongles(props.config.telefony.executable.trim() || undefined);
    dongles.value = result.dongles;
    dongleError.value = result.probeError || result.pnpError || '';
  } catch (error) {
    dongleError.value = (error as Error).message || 'Could not list Bluetooth controllers.';
  } finally {
    loadingDongles.value = false;
  }
}

function setScoChannels(value: number | null): void {
  if (value === null) return;
  scoChannels.value = value;
  const current = parseTransport(line.value.transport);
  if (current) line.value.transport = `usb:${current.id}+sco=${value}`;
}

function markDeviceNameEdited(): void {
  emit('deviceNameEdited');
}

onMounted(() => {
  void refreshDongles();
});

watch(() => props.config.telefony.executable, () => {
  void refreshDongles();
});
</script>

<template>
  <section class="stack" aria-label="Phone provider setup">
    <h3>telefony-app setup</h3>
    <div class="grid2">
      <label class="field">
        <span>Shared telefony-app executable</span>
        <div class="row">
          <FormField v-slot="{ inputAttrs }" :value="config.telefony.executable" class="grow" hint="This executable is shared by every phone. Saving it applies through each line's idle-safe restart." :validate="phoneSetupExecutableError" :block-save="false">
            <InputText v-model="config.telefony.executable" v-bind="inputAttrs" class="grow" :disabled="disabled" aria-label="Shared telefony-app executable" placeholder="Path to telefony-app" />
          </FormField>
          <ServerFilePicker :disabled="disabled" @select="config.telefony.executable = $event" />
        </div>
      </label>

      <label class="field">
        <span>Bluetooth transport</span>
        <div class="row">
          <FormField v-slot="{ inputAttrs }" :value="line.transport" class="grow" hint="Select a detected controller or enter a transport identifier from telefony-app.">
            <InputText v-model="line.transport" v-bind="inputAttrs" class="grow" :disabled="disabled" :aria-label="`${idPrefix} Bluetooth transport`" placeholder="usb:10D7:B012+sco=2" />
          </FormField>
          <Button label="Scan" severity="secondary" :disabled="disabled || loadingDongles" :loading="loadingDongles" @click="refreshDongles" />
        </div>
        <FormField v-slot="{ inputAttrs }" :value="selectedDongleId" hint="The selected controller must be available to telefony-app.">
          <AppSelect v-model="selectedDongleId" v-bind="inputAttrs" :options="dongleOptions" option-label="label" option-value="value" option-disabled="disabled" :disabled="disabled" aria-label="Detected Bluetooth controller" placeholder="Choose a detected controller" />
        </FormField>
        <div v-if="selectedDongleId" class="row">
          <FormField v-slot="{ inputAttrs }" :value="scoChannels" class="grow" hint="SCO channels used by this Bluetooth controller.">
            <AppInputNumber :model-value="scoChannels" v-bind="inputAttrs" :allow-empty="false" :min="1" :max="8" :step="1" :disabled="disabled" aria-label="SCO channels" @update:model-value="setScoChannels" />
          </FormField>
        </div>
        <small v-if="dongleError" class="muted">{{ dongleError }}</small>
      </label>

      <label class="field">
        <span>Bluetooth device name</span>
        <FormField v-slot="{ inputAttrs }" :value="line.deviceName" hint="Trimmed and limited to 248 UTF-8 bytes. Saving changes restarts telefony when the line is idle.">
          <InputText v-model="line.deviceName" v-bind="inputAttrs" :disabled="disabled" :aria-label="`${idPrefix} Bluetooth device name`" @update:model-value="markDeviceNameEdited" />
        </FormField>
      </label>

      <PhoneVoiceFields :config="config" :phone="phone" :disabled="disabled" :id-prefix="idPrefix" />
    </div>
  </section>
</template>
