<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { api, type PhoneEntry, type TimbreConfig, type VoiceChoice } from '../api';
import type { TelefonySetupDescriptor, TelefonySetupField } from '../../src/phone/setup/telefony-setup-descriptor.js';
import AppSelect from './AppSelect.vue';
import FormField from './FormField.vue';
import ServerFilePicker from './ServerFilePicker.vue';
import { piperModelPathError } from '../field-validation';

const PROVIDER_DEFAULT = '__provider_default__';
const props = withDefaults(defineProps<{
  config: TimbreConfig;
  phone: PhoneEntry;
  disabled?: boolean;
  idPrefix: string;
  showVoiceTools?: boolean;
  run?: (fn: () => Promise<unknown>) => Promise<unknown>;
  serverError?: string;
}>(), { disabled: false, showVoiceTools: false });

const emit = defineEmits<{ 'update:customPiperModels': [paths: string[]] }>();
const descriptor = ref<TelefonySetupDescriptor | null>(null);
const descriptorError = ref('');
const voiceLoadError = ref('');
const voices = ref<VoiceChoice[]>([]);
const modelPath = ref('');
const audioUrl = ref('');
const audio = ref<HTMLAudioElement>();

const line = computed(() => props.phone.line);
const ttsField = computed(() => setupField('voice.tts'));
const piperField = computed(() => setupField('voice.piper_model'));
const sapiField = computed(() => setupField('voice.sapi_voice'));
const sttField = computed(() => setupField('voice.stt_model'));
const piperChoices = computed(() => voices.value.filter((voice) => voice.type === 'piper'));
const sapiChoices = computed(() => voices.value.filter((voice) => voice.type === 'sapi'));
const customVoices = computed(() => piperChoices.value.filter((voice) => voice.source === 'custom'));
const previewVoice = computed(() => {
  if (line.value.voice.tts === 'sapi' && line.value.voice.sapiVoice) {
    return sapiChoices.value.find((voice) => voice.sapiVoice === line.value.voice.sapiVoice);
  }
  if (line.value.voice.tts === 'piper' && line.value.voice.piperModel) {
    return piperChoices.value.find((voice) => voice.modelPath === line.value.voice.piperModel);
  }
  return undefined;
});

const ttsMode = computed({
  get: () => line.value.voice.tts || PROVIDER_DEFAULT,
  set: (value: string) => { line.value.voice.tts = value === PROVIDER_DEFAULT ? '' : value; },
});
const piperModelChoice = computed({
  get: () => line.value.voice.piperModel || PROVIDER_DEFAULT,
  set: (value: string) => { line.value.voice.piperModel = value === PROVIDER_DEFAULT ? '' : value; },
});
const sapiVoiceChoice = computed({
  get: () => line.value.voice.sapiVoice || PROVIDER_DEFAULT,
  set: (value: string) => { line.value.voice.sapiVoice = value === PROVIDER_DEFAULT ? '' : value; },
});

function setupField(key: string): TelefonySetupField | undefined {
  return descriptor.value?.fields.find((field) => field.key === key);
}

function defaultLabel(field: TelefonySetupField): string {
  const value = field.default;
  const shown = value === null || value === '' ? 'not set' : choiceLabel(String(value));
  return `Provider default (${shown})`;
}

function choiceLabel(value: string): string {
  if (value === 'none') return 'Off';
  if (value === 'sapi') return 'SAPI';
  return value.length ? value[0].toUpperCase() + value.slice(1) : value;
}

const ttsOptions = computed(() => {
  const field = ttsField.value;
  if (!field) return [];
  return [
    { label: defaultLabel(field), value: PROVIDER_DEFAULT },
    ...(field.choices ?? []).map((value) => ({ label: choiceLabel(value), value })),
  ];
});

const piperOptions = computed(() => {
  const field = piperField.value;
  if (!field) return [];
  const options = [
    { label: defaultLabel(field), value: PROVIDER_DEFAULT },
    ...piperChoices.value.map((voice) => ({ label: voice.label, value: voice.modelPath })),
  ];
  if (line.value.voice.piperModel && !options.some((option) => option.value === line.value.voice.piperModel)) {
    options.push({ label: `Current: ${line.value.voice.piperModel}`, value: line.value.voice.piperModel });
  }
  return options;
});

const sapiOptions = computed(() => {
  const field = sapiField.value;
  if (!field) return [];
  const options = [
    { label: defaultLabel(field), value: PROVIDER_DEFAULT },
    ...sapiChoices.value.map((voice) => ({ label: voice.label, value: voice.sapiVoice })),
  ];
  if (line.value.voice.sapiVoice && !options.some((option) => option.value === line.value.voice.sapiVoice)) {
    options.push({ label: `Current: ${line.value.voice.sapiVoice}`, value: line.value.voice.sapiVoice });
  }
  return options;
});

const sttOptions = computed(() => {
  const field = sttField.value;
  if (!field) return [];
  return [
    { label: defaultLabel(field), value: PROVIDER_DEFAULT },
    ...(field.choices ?? []).map((value) => ({ label: choiceLabel(value), value })),
    { label: 'Custom model or path', value: '__custom__' },
  ];
});

const sttMode = computed({
  get: () => {
    const value = line.value.voice.sttModel;
    if (!value) return PROVIDER_DEFAULT;
    if ((sttField.value?.choices ?? []).includes(value)) return value;
    return '__custom__';
  },
  set: (value: string) => {
    if (value === PROVIDER_DEFAULT) {
      line.value.voice.sttModel = '';
    } else if (value === '__custom__') {
      const current = line.value.voice.sttModel;
      if (!current || (sttField.value?.choices ?? []).includes(current)) {
        line.value.voice.sttModel = typeof sttField.value?.default === 'string' ? sttField.value.default : '';
      }
    } else {
      line.value.voice.sttModel = value;
    }
  },
});

async function loadDescriptor(): Promise<void> {
  descriptorError.value = '';
  try {
    descriptor.value = await api.phoneSetupDescriptor();
  } catch (error) {
    descriptor.value = null;
    descriptorError.value = (error as Error).message || 'Update telefony-app to load provider setup choices.';
  }
}

async function loadVoices(): Promise<void> {
  try {
    voices.value = await api.voices();
    voiceLoadError.value = '';
  } catch (error) {
    voiceLoadError.value = (error as Error).message || 'Could not load voice catalogue.';
    throw error;
  }
}

async function runTask(task: () => Promise<unknown>): Promise<void> {
  if (props.run) await props.run(task);
  else await task();
}

async function registerModel(): Promise<void> {
  const value = modelPath.value.trim();
  if (!value) return;
  await runTask(async () => {
    const result = await api.registerPiperModel(value);
    emit('update:customPiperModels', result.customPiperModels);
    modelPath.value = '';
    await loadVoices();
  });
}

async function removeModel(voice: VoiceChoice): Promise<void> {
  if (voice.type !== 'piper' || voice.source !== 'custom') return;
  await runTask(async () => {
    const result = await api.removePiperModel(voice.modelPath);
    emit('update:customPiperModels', result.customPiperModels);
    await loadVoices();
  });
}

async function playPreview(): Promise<void> {
  if (!previewVoice.value) return;
  await runTask(async () => {
    const blob = await api.previewVoice(previewVoice.value!.id);
    if (audioUrl.value) URL.revokeObjectURL(audioUrl.value);
    audioUrl.value = URL.createObjectURL(blob);
    await audio.value?.play().catch(() => undefined);
  });
}

onMounted(() => {
  void loadDescriptor();
  void loadVoices().catch(() => undefined);
});
watch(() => props.config.telefony.executable, () => { void loadDescriptor(); });
onBeforeUnmount(() => { if (audioUrl.value) URL.revokeObjectURL(audioUrl.value); });
</script>

<template>
  <section class="stack" :class="{ panel: showVoiceTools }" aria-label="Phone voice settings">
    <template v-if="descriptor">
      <div class="grid2">
        <label v-if="ttsField" class="field">
          <span>{{ ttsField.label }}</span>
          <FormField v-slot="{ inputAttrs }" :value="line.voice.tts" :hint="ttsField.help ?? 'Choose a provider default or an explicit mode.'">
            <AppSelect v-model="ttsMode" v-bind="inputAttrs" :options="ttsOptions" option-label="label" option-value="value" :disabled="disabled" :aria-label="ttsField.label" />
          </FormField>
        </label>

        <label v-if="piperField" class="field">
          <span>{{ piperField.label }}</span>
          <FormField v-slot="{ inputAttrs }" :value="line.voice.piperModel" class="grow" :hint="piperField.help ?? 'Choose a catalogue model, browse for a file, or use the provider default.'" :validate="piperModelPathError" :server-error="serverError?.startsWith('Piper model') ? serverError : ''">
            <AppSelect v-model="piperModelChoice" :options="piperOptions" option-label="label" option-value="value" :disabled="disabled" :aria-label="piperField.label" />
            <div class="row">
              <InputText v-model="line.voice.piperModel" v-bind="inputAttrs" class="grow" :disabled="disabled" :aria-label="`${idPrefix} Piper model path`" placeholder="Provider default or absolute .onnx path" />
              <ServerFilePicker extension=".onnx" :disabled="disabled" @select="line.voice.piperModel = $event" />
            </div>
          </FormField>
        </label>

        <label v-if="sapiField" class="field">
          <span>{{ sapiField.label }}</span>
          <FormField v-slot="{ inputAttrs }" :value="line.voice.sapiVoice" :hint="sapiField.help ?? 'Choose an installed voice or use the provider default.'">
            <AppSelect v-model="sapiVoiceChoice" v-bind="inputAttrs" :options="sapiOptions" option-label="label" option-value="value" :disabled="disabled" :aria-label="sapiField.label" />
          </FormField>
        </label>

        <label v-if="sttField" class="field">
          <span>{{ sttField.label }}</span>
          <FormField v-slot="{ inputAttrs }" :value="line.voice.sttModel" :hint="sttField.help ?? 'Use the provider default, turn speech recognition off, or enter a model.'">
            <AppSelect v-model="sttMode" v-bind="inputAttrs" :options="sttOptions" option-label="label" option-value="value" :disabled="disabled" :aria-label="sttField.label" />
            <div v-if="sttMode === '__custom__'" class="row">
              <InputText v-model="line.voice.sttModel" v-bind="inputAttrs" class="grow" :disabled="disabled" :aria-label="`${idPrefix} Speech recognition model`" placeholder="Model name or server path" />
              <ServerFilePicker :disabled="disabled" @select="line.voice.sttModel = $event" />
            </div>
          </FormField>
        </label>
      </div>
    </template>
    <p v-if="descriptorError" class="error-banner" role="alert">{{ descriptorError }} Saved phones keep running; update telefony-app to edit provider settings.</p>
    <p v-else-if="!descriptor" class="muted" role="status">Loading provider setup…</p>
    <p v-if="voiceLoadError" class="muted" role="alert">{{ voiceLoadError }}</p>

    <template v-if="showVoiceTools">
      <div class="row">
        <span class="grow">Preview the selected Piper model or SAPI voice.</span>
        <Button label="Play preview" severity="secondary" :disabled="disabled || !previewVoice" @click="playPreview" />
      </div>
      <audio v-if="audioUrl" ref="audio" :src="audioUrl" controls aria-label="Voice preview audio" />
      <h3>Custom Piper model</h3>
      <p class="muted">Add an absolute .onnx path with its adjacent .onnx.json file.</p>
      <div class="row">
        <FormField v-slot="{ inputAttrs }" :value="modelPath" class="grow" hint="Use an absolute .onnx path with its existing adjacent .onnx.json file." :validate="piperModelPathError" :server-error="serverError?.startsWith('Piper model') ? serverError : ''" :block-save="false">
          <InputText v-model="modelPath" v-bind="inputAttrs" class="grow" aria-label="Custom Piper model path" :disabled="disabled" />
        </FormField>
        <ServerFilePicker extension=".onnx" :disabled="disabled" @select="modelPath = $event" />
        <Button label="Add model" severity="secondary" :disabled="disabled || !modelPath.trim() || !!piperModelPathError(modelPath)" @click="registerModel" />
      </div>
      <ul v-if="customVoices.length" class="stack">
        <li v-for="voice in customVoices" :key="voice.id" class="row">
          <span class="grow">{{ voice.modelPath }}</span>
          <Button label="Remove" severity="danger" text :disabled="disabled" @click="removeModel(voice)" />
        </li>
      </ul>
    </template>
  </section>
</template>
