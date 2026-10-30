<script setup lang="ts">
import type { ClaudeCodeExtraTool } from '../../src/config/claude-code-tools.js';
import { CLAUDE_CODE_EXTRA_TOOLS } from '../../src/config/claude-code-tools.js';
import type { CliLlm } from '../api';
import InputText from 'primevue/inputtext';
import FormField from './FormField.vue';

defineProps<{ llm: CliLlm; busy: boolean }>();

const labels: Record<ClaudeCodeExtraTool, string> = {
  Bash: 'Run shell commands',
  Write: 'Create files',
  Edit: 'Edit files',
  WebFetch: 'Fetch web pages',
};

</script>

<template>
  <section class="panel stack" aria-label="Claude Code preset">
    <h2>Restricted Claude Code</h2>
    <label class="field"><span>Claude Code command</span><FormField v-slot="{ inputAttrs }" :value="llm.command" hint="Command is required for a CLI model." :validate="(value) => typeof value === 'string' && value.trim() ? null : 'Command is required.'"><InputText v-model="llm.command" v-bind="inputAttrs" placeholder="claude" required :disabled="busy" /></FormField></label>
    <p class="muted">Timbre phone tools are enabled by default. Select any extra Claude Code tools this phone may use.</p>
    <FormField v-slot="{ inputAttrs }" :value="llm.extraAllowedTools ?? []" hint="Optional; choose any of the four listed extra tools.">
    <div class="stack" v-bind="inputAttrs">
      <label v-for="tool in CLAUDE_CODE_EXTRA_TOOLS" :key="tool" class="row">
        <input v-model="llm.extraAllowedTools" type="checkbox" :value="tool" :aria-label="`Allow ${tool}`" :disabled="busy" />
        <span>{{ labels[tool] }} ({{ tool }})</span>
      </label>
    </div>
    </FormField>
  </section>
</template>
