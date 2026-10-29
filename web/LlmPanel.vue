<script setup lang="ts">
import type { LlmConfig } from './api';

const props = defineProps<{ llm: LlmConfig; canRemove: boolean }>();
defineEmits<{ remove: [] }>();

/** CLI args are edited as one line, split on spaces. */
function setArgs(text: string) {
  if (props.llm.kind === 'cli') props.llm.args = text.split(' ').filter(Boolean);
}
</script>

<template>
  <section class="panel stack">
    <div class="row">
      <input v-model="llm.name" class="grow" aria-label="Name" />
      <span class="muted">{{ llm.kind === 'api' ? 'API model' : 'CLI in a terminal' }}</span>
      <button v-if="canRemove" class="danger" @click="$emit('remove')">Remove</button>
    </div>
    <div v-if="llm.kind === 'api'" class="grid2">
      <label class="field"><span>Base URL (OpenAI-compatible)</span><input v-model="llm.baseUrl" placeholder="http://127.0.0.1:8080/v1" /></label>
      <label class="field"><span>Model</span><input v-model="llm.model" /></label>
      <label class="field"><span>API key (optional)</span><input v-model="llm.apiKey" type="password" autocomplete="off" /></label>
    </div>
    <div v-else class="stack">
      <div class="grid2">
        <label class="field"><span>Command</span><input v-model="llm.command" placeholder="claude" /></label>
        <label class="field"><span>Working folder</span><input v-model="llm.cwd" /></label>
      </div>
      <label class="field">
        <span>Arguments: {mcpConfig} = MCP config file, {mcpUrl} = MCP URL</span>
        <input :value="llm.args.join(' ')" @change="setArgs(($event.target as HTMLInputElement).value)" />
      </label>
    </div>
  </section>
</template>
