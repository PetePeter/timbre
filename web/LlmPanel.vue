<script setup lang="ts">
import type { LlmConfig } from './api';
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import AppInputNumber from './components/AppInputNumber.vue';
import AppSelect from './components/AppSelect.vue';
import FormField from './components/FormField.vue';
import ServerFilePicker from './components/ServerFilePicker.vue';
import { dailyTokenLimitError } from './field-validation';

const requiredBaseUrlError = (value: unknown) => typeof value === 'string' && value.trim() ? null : 'Base URL is required.';
const requiredModelError = (value: unknown) => typeof value === 'string' && value.trim() ? null : 'Model is required.';
const requiredCommandError = (value: unknown) => typeof value === 'string' && value.trim() ? null : 'Command is required.';

const props = defineProps<{ llm: LlmConfig; canRemove: boolean; busy: boolean }>();
const emit = defineEmits<{ remove: []; 'update:args': [args: string[]] }>();
const apiLlm = computed(() => props.llm.kind === 'api' ? props.llm : null);
const cliLlm = computed(() => props.llm.kind === 'cli' ? props.llm : null);
const argsText = ref('');
const baseUrlPlaceholder = 'http://127.0.0.1:8080/v1';

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
      <FormField v-slot="{ inputAttrs }" :value="llm.name" class="grow" hint="No fixed length or format limit is enforced."><InputText v-model="llm.name" v-bind="inputAttrs" class="grow" aria-label="Name" /></FormField>
      <span class="muted">{{ llm.kind === 'api' ? 'API model' : llm.preset === 'claude-code' ? 'Restricted Claude Code' : 'CLI in a terminal' }}</span>
      <Button v-if="canRemove" severity="danger" text @click="$emit('remove')">Remove</Button>
    </div>
    <div v-if="apiLlm" class="grid2">
      <label class="field"><span>Base URL (OpenAI-compatible)</span><FormField v-slot="{ inputAttrs }" :value="apiLlm!.baseUrl" hint="Base URL is required for an API model." :validate="requiredBaseUrlError"><InputText v-model="apiLlm!.baseUrl" v-bind="inputAttrs" :placeholder="baseUrlPlaceholder" required /></FormField></label>
      <label class="field"><span>Model</span><FormField v-slot="{ inputAttrs }" :value="apiLlm!.model" hint="Model is required for an API model." :validate="requiredModelError"><InputText v-model="apiLlm!.model" v-bind="inputAttrs" required /></FormField></label>
      <label class="field"><span>API key (optional)</span><FormField v-slot="{ inputAttrs }" :value="apiLlm!.apiKey" hint="Optional; no fixed length limit is enforced."><InputText v-model="apiLlm!.apiKey" v-bind="inputAttrs" type="password" autocomplete="off" /></FormField></label>
      <label class="field"><span>Agent mode</span>
        <FormField v-slot="{ inputAttrs }" :value="apiLlm!.mode ?? 'full'" hint="Choose one of the listed agent modes."><AppSelect :model-value="apiLlm!.mode ?? 'full'" v-bind="inputAttrs" :options="[{ label: 'Handover only', value: 'handover' }, { label: 'Full tools', value: 'full' }]" option-label="label" option-value="value" aria-label="API model mode" @update:model-value="updateApiMode" /></FormField>
      </label>
      <label class="field"><span>Daily token cap (0 = unlimited)</span>
        <FormField v-slot="{ inputAttrs }" :value="apiLlm!.dailyTokenLimit ?? 0" hint="Use 0 or more tokens; fractions are rounded down and 0 is unlimited." :validate="dailyTokenLimitError"><AppInputNumber :model-value="apiLlm!.dailyTokenLimit ?? 0" v-bind="inputAttrs" :use-grouping="false" :allow-empty="false" :min="0" :step="1" aria-label="Daily token cap" @update:model-value="updateDailyTokenLimit" /></FormField>
      </label>
    </div>
    <div v-else-if="cliLlm && cliLlm.preset !== 'claude-code'" class="stack">
      <div class="grid2">
        <div class="field">
          <span><label :for="`cli-command-${cliLlm.id}`">Command</label></span>
          <div class="row">
            <FormField v-slot="{ inputAttrs }" :value="cliLlm.command" class="grow" hint="Command is required for a CLI model." :validate="requiredCommandError"><InputText :id="`cli-command-${cliLlm.id}`" v-model="cliLlm.command" v-bind="inputAttrs" class="grow" placeholder="claude" required /></FormField>
            <ServerFilePicker :disabled="busy" @select="cliLlm.command = $event" />
          </div>
        </div>
        <label class="field"><span>Working folder</span><FormField v-slot="{ inputAttrs }" :value="cliLlm.cwd" hint="Optional; no fixed length limit is enforced."><InputText v-model="cliLlm.cwd" v-bind="inputAttrs" /></FormField></label>
      </div>
      <label class="field">
        <span>Arguments: {mcpConfig} = MCP config file, {mcpUrl} = MCP URL</span>
        <FormField v-slot="{ inputAttrs }" :value="argsText" hint="Enter command arguments separated by spaces; no length limit is enforced."><InputText v-model="argsText" v-bind="inputAttrs" @change="commitArgs" /></FormField>
      </label>
    </div>
  </fieldset>
</template>
