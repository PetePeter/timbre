<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import AppSelect from './AppSelect.vue';
import { api, type PhoneEntry, type VoiceChoice } from '../api';

const props = defineProps<{
  phone: PhoneEntry;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<unknown>;
}>();
const emit = defineEmits<{ 'update:customPiperModels': [paths: string[]] }>();

const voices = ref<VoiceChoice[]>([]);
const loadError = ref('');
const customVoices = computed(() => voices.value.filter(
  (voice): voice is Extract<VoiceChoice, { type: 'piper' }> => voice.type === 'piper' && voice.source === 'custom',
));
const modelPath = ref('');
const audioUrl = ref('');
const audio = ref<HTMLAudioElement>();
const selected = computed({
  get: () => {
    const voice = props.phone.line.voice;
    if (voice.tts === 'sapi') return voices.value.find((choice) => choice.type === 'sapi' && choice.sapiVoice === voice.sapiVoice)?.id ?? '';
    if (voice.tts === 'none') return 'none';
    if (voice.piperModel) return voices.value.find((choice) => choice.type === 'piper' && choice.modelPath === voice.piperModel)?.id ?? '';
    return 'auto';
  },
  set: (id: string) => {
    const voice = props.phone.line.voice;
    if (id === 'auto') { voice.tts = 'auto'; voice.piperModel = ''; voice.sapiVoice = ''; return; }
    if (id === 'none') { voice.tts = 'none'; voice.piperModel = ''; voice.sapiVoice = ''; return; }
    const choice = voices.value.find((item) => item.id === id);
    if (choice?.type === 'piper') {
      voice.tts = 'piper'; voice.piperModel = choice.modelPath; voice.sapiVoice = '';
    } else if (choice?.type === 'sapi') {
      voice.tts = 'sapi'; voice.piperModel = ''; voice.sapiVoice = choice.sapiVoice;
    }
  },
});
const options = computed(() => [
  { label: 'Automatic', value: 'auto' },
  { label: 'No speech', value: 'none' },
  ...voices.value.map((voice) => ({
    label: `${voice.type === 'piper' ? 'Piper' : voice.sapiVoice ? 'SAPI' : ''} · ${voice.label}${voice.source === 'custom' ? ' · custom' : ''}`.replace(/^ · /u, ''),
    value: voice.id,
  })),
]);

async function refresh() {
  try {
    voices.value = await api.voices();
    loadError.value = '';
  } catch (error) {
    loadError.value = (error as Error).message;
    throw error;
  }
}
async function registerModel() {
  const value = modelPath.value.trim();
  if (!value) return;
  await props.run(async () => {
    const result = await api.registerPiperModel(value);
    emit('update:customPiperModels', result.customPiperModels);
    modelPath.value = '';
    await refresh();
  });
}
async function removeModel(voice: VoiceChoice) {
  if (voice.type !== 'piper' || voice.source !== 'custom') return;
  await props.run(async () => {
    const result = await api.removePiperModel(voice.modelPath);
    emit('update:customPiperModels', result.customPiperModels);
    await refresh();
  });
}
async function preview() {
  if (!selected.value || selected.value === 'auto' || selected.value === 'none') return;
  await props.run(async () => {
    const blob = await api.previewVoice(selected.value);
    if (audioUrl.value) URL.revokeObjectURL(audioUrl.value);
    audioUrl.value = URL.createObjectURL(blob);
    await audio.value?.play().catch(() => undefined);
  });
}

onMounted(() => { void refresh().catch(() => undefined); });
onBeforeUnmount(() => { if (audioUrl.value) URL.revokeObjectURL(audioUrl.value); });
</script>

<template>
  <section class="panel stack">
    <h2>Phone voice</h2>
    <p v-if="loadError" class="muted" role="alert">{{ loadError }}</p>
    <div class="grid2">
      <label class="field"><span>Voice</span><AppSelect v-model="selected" :options="options" option-label="label" option-value="value" :disabled="busy" aria-label="Phone voice" /></label>
      <div class="field"><span>Preview</span><Button label="Play preview" severity="secondary" :disabled="busy || !selected || ['auto', 'none'].includes(selected)" @click="preview" /></div>
    </div>
    <audio v-if="audioUrl" ref="audio" :src="audioUrl" controls aria-label="Voice preview audio" />
    <h3>Custom Piper model</h3>
    <p class="muted">Add an absolute .onnx path with its adjacent .onnx.json file.</p>
    <div class="row">
      <InputText v-model="modelPath" class="grow" aria-label="Custom Piper model path" :disabled="busy" />
      <Button label="Add model" severity="secondary" :disabled="busy || !modelPath.trim()" @click="registerModel" />
    </div>
    <ul v-if="customVoices.length" class="stack">
      <li v-for="voice in customVoices" :key="voice.id" class="row">
        <span class="grow">{{ voice.modelPath }}</span>
        <Button label="Remove" severity="danger" text :disabled="busy" @click="removeModel(voice)" />
      </li>
    </ul>
  </section>
</template>
