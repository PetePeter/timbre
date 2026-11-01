<script setup lang="ts">
import { CLAUDE_CODE_TOOL_CATEGORIES, normalizeClaudeCodeExtraTools } from '../../src/config/claude-code-tools.js';
import type { CliLlm } from '../api';
import InputText from 'primevue/inputtext';
import FormField from './FormField.vue';
import ServerFilePicker from './ServerFilePicker.vue';

type Category = typeof CLAUDE_CODE_TOOL_CATEGORIES[number];

const props = defineProps<{ llm: CliLlm; busy: boolean }>();

function isOn(category: Category): boolean {
  return category.tools.some((tool) => props.llm.extraAllowedTools?.includes(tool));
}

function toggle(category: Category, on: boolean): void {
  const others = (props.llm.extraAllowedTools ?? []).filter((tool) => !(category.tools as readonly string[]).includes(tool));
  props.llm.extraAllowedTools = normalizeClaudeCodeExtraTools(on ? [...others, ...category.tools] : others);
}

</script>

<template>
  <section class="panel stack" aria-label="Claude Code preset">
    <h2>Restricted Claude Code</h2>
    <div class="field">
      <span><label :for="`claude-code-command-${llm.id}`">Claude Code command</label></span>
      <div class="row">
        <FormField v-slot="{ inputAttrs }" :value="llm.command" class="grow" hint="Command is required for a CLI model." :validate="(value) => typeof value === 'string' && value.trim() ? null : 'Command is required.'"><InputText :id="`claude-code-command-${llm.id}`" v-model="llm.command" v-bind="inputAttrs" class="grow" placeholder="claude" required :disabled="busy" /></FormField>
        <ServerFilePicker :disabled="busy" @select="llm.command = $event" />
      </div>
    </div>
    <p class="muted">Timbre phone tools are always enabled. Everything else is off unless you switch it on here.</p>
    <FormField v-slot="{ inputAttrs }" :value="llm.extraAllowedTools ?? []" hint="Optional; each switch enables the listed Claude Code tools together.">
    <fieldset class="stack extra-tools" v-bind="inputAttrs">
      <legend>Extra tools</legend>
      <label v-for="category in CLAUDE_CODE_TOOL_CATEGORIES" :key="category.id" class="row">
        <input type="checkbox" :checked="isOn(category)" :aria-label="`Allow ${category.label}`" :disabled="busy" @change="toggle(category, ($event.target as HTMLInputElement).checked)" />
        <span>{{ category.label }} ({{ category.tools.join(', ') }})</span>
      </label>
    </fieldset>
    </FormField>
  </section>
</template>

<style scoped>
.extra-tools { border: 0; padding: 0; }
</style>
