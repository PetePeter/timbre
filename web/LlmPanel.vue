<script setup lang="ts">
import type { LlmConfig } from './api';
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import AppSelect from './components/AppSelect.vue';

const props = defineProps<{ llm: LlmConfig; canRemove: boolean; busy: boolean }>();
const emit = defineEmits<{ remove: []; 'update:args': [args: string[]] }>();
const apiLlm = computed(() => props.llm.kind === 'api' ? props.llm : null);
const cliLlm = computed(() => props.llm.kind === 'cli' ? props.llm : null);
const argsText = ref('');

watch(() => cliLlm.value?.args.join(' ') ?? '', (text) => { argsText.value = text; }, { immediate: true });

/** CLI args are edited as one line and committed when the field changes. */
function commitArgs() {
  emit('update:args', argsText.value.split(' ').filter(Boolean));
}

function updateApiMode(value: 'handover' | 'full') {
  const llm = apiLlm.value;
  if (llm) llm.mode = value;
}

function updateDailyTokenLimit(value: number | null) {
  const llm = apiLlm.value;
  if (llm) llm.dailyTokenLimit = Math.max(0, Math.floor(value ?? 0));
}
</script>

<template>
  <fieldset class="panel stack" :disabled="busy">
    <legend class="visually-hidden">{{ llm.kind === 'api' ? 'API model' : 'CLI model' }} settings</legend>
    <div class="row">
      <InputText v-model="llm.name" class="grow" aria-label="Name" />
      <span class="muted">{{ llm.kind === 'api' ? 'API model' : 'CLI in a terminal' }}</span>
      <Button v-if="canRemove" severity="danger" text @click="$emit('remove')">Remove</Button>
    </div>
    <div v-if="apiLlm" class="grid2">
      <label class="field"><span>Base URL (OpenAI-compatible)</span><InputText v-model="apiLlm!.baseUrl" placeholder="http://127.0.0.1:8080/v1" /></label>
      <label class="field"><span>Model</span><InputText v-model="apiLlm!.model" /></label>
      <label class="field"><span>API key (optional)</span><InputText v-model="apiLlm!.apiKey" type="password" autocomplete="off" /></label>
      <label class="field"><span>Agent mode</span>
        <AppSelect :model-value="apiLlm!.mode ?? 'full'" :options="[{ label: 'Handover only', value: 'handover' }, { label: 'Full tools', value: 'full' }]" option-label="label" option-value="value" aria-label="API model mode" @update:model-value="updateApiMode" />
      </label>
      <label class="field"><span>Daily token cap (0 = unlimited)</span>
        <InputNumber :model-value="apiLlm!.dailyTokenLimit ?? 0" :use-grouping="false" :allow-empty="false" :min="0" aria-label="Daily token cap" @update:model-value="updateDailyTokenLimit" />
      </label>
    </div>
    <div v-else-if="cliLlm" class="stack">
      <div class="grid2">
        <label class="field"><span>Command</span><InputText v-model="cliLlm.command" placeholder="claude" /></label>
        <label class="field"><span>Working folder</span><InputText v-model="cliLlm.cwd" /></label>
      </div>
      <label class="field">
        <span>Arguments: {mcpConfig} = MCP config file, {mcpUrl} = MCP URL</span>
        <InputText v-model="argsText" @change="commitArgs" />
      </label>
    </div>
  </fieldset>
</template>
