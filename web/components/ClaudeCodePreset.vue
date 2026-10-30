<script setup lang="ts">
import type { ClaudeCodeExtraTool } from '../../src/config/claude-code-tools.js';
import { CLAUDE_CODE_EXTRA_TOOLS } from '../../src/config/claude-code-tools.js';
import type { CliLlm } from '../api';
import InputText from 'primevue/inputtext';

defineProps<{ llm: CliLlm; busy: boolean }>();

const labels: Record<ClaudeCodeExtraTool, string> = {
  Bash: 'Run shell commands',
  Write: 'Create files',
  Edit: 'Edit files',
  WebFetch: 'Fetch web pages',
};

function isSelected(llm: CliLlm, tool: ClaudeCodeExtraTool): boolean {
  return llm.extraAllowedTools?.includes(tool) ?? false;
}

function setSelected(llm: CliLlm, tool: ClaudeCodeExtraTool, enabled: boolean): void {
  const selected = new Set(llm.extraAllowedTools ?? []);
  if (enabled) selected.add(tool);
  else selected.delete(tool);
  llm.extraAllowedTools = CLAUDE_CODE_EXTRA_TOOLS.filter((candidate) => selected.has(candidate));
}

function onChange(llm: CliLlm, tool: ClaudeCodeExtraTool, event: Event): void {
  setSelected(llm, tool, (event.target as HTMLInputElement).checked);
}
</script>

<template>
  <section class="panel stack" aria-label="Claude Code preset">
    <h2>Restricted Claude Code</h2>
    <label class="field"><span>Claude Code command</span><InputText v-model="llm.command" placeholder="claude" :disabled="busy" /></label>
    <p class="muted">Timbre phone tools are enabled by default. Select any extra Claude Code tools this phone may use.</p>
    <div class="stack">
      <label v-for="tool in CLAUDE_CODE_EXTRA_TOOLS" :key="tool" class="row">
        <input type="checkbox" :aria-label="`Allow ${tool}`" :checked="isSelected(llm, tool)" :disabled="busy" @change="onChange(llm, tool, $event)" />
        <span>{{ labels[tool] }} ({{ tool }})</span>
      </label>
    </div>
  </section>
</template>
