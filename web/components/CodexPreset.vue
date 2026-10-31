<script setup lang="ts">
import type { CliLlm } from '../api';
import InputText from 'primevue/inputtext';
import FormField from './FormField.vue';
import ServerFilePicker from './ServerFilePicker.vue';

defineProps<{ llm: CliLlm; busy: boolean }>();
</script>

<template>
  <section class="panel stack" aria-label="Codex preset">
    <h2>Restricted Codex CLI</h2>
    <div class="field">
      <span><label :for="`codex-command-${llm.id}`">Codex command</label></span>
      <div class="row">
        <FormField v-slot="{ inputAttrs }" :value="llm.command" class="grow" hint="Command is required for a CLI model." :validate="(value) => typeof value === 'string' && value.trim() ? null : 'Command is required.'"><InputText :id="`codex-command-${llm.id}`" v-model="llm.command" v-bind="inputAttrs" class="grow" placeholder="codex" required :disabled="busy" /></FormField>
        <ServerFilePicker :disabled="busy" @select="llm.command = $event" />
      </div>
    </div>
    <p class="muted">This phone uses only its Timbre MCP. Local shell tools are disabled and the workspace is read-only. Timbre MCP tools run without approval prompts.</p>
  </section>
</template>
