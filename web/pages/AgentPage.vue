<script setup lang="ts">
import { computed } from 'vue';
import Button from 'primevue/button';
import LlmPanel from '../LlmPanel.vue';
import AppTokensSection from '../components/AppTokensSection.vue';
import McpServersEditor from '../components/McpServersEditor.vue';
import PersonaSettings from '../components/PersonaSettings.vue';
import { useAppState } from '../app-state';
import type { CliLlm, LlmConfig } from '../api';
const state = useAppState();
const selectedPhoneLlm = computed(() => state.cfg?.llms.find((llm) => llm.id === state.selectedPhone?.llmId));
const selectedUsesPersona = computed(() => selectedPhoneLlm.value?.kind === 'api'
  || (selectedPhoneLlm.value?.kind === 'cli'
    && (selectedPhoneLlm.value.preset === 'claude-code' || selectedPhoneLlm.value.preset === 'codex')));

function updateArgs(llm: LlmConfig, args: string[]) {
  if (llm.kind === 'cli') llm.args = args;
}
</script>
<template>
  <div class="page-heading"><div><h1>Agent</h1><p>Who answers your phones, and how they connect.</p></div></div>
  <div v-if="state.cfg" class="stack">
    <LlmPanel v-for="llm in state.cfg.llms" :key="llm.id" :llm="llm" :can-remove="state.cfg.llms.length > 1" :busy="state.busy" @remove="state.removeLlm(llm.id)" @update:args="updateArgs(llm, $event)" />
    <div class="row"><Button label="+ API model" :disabled="state.busy" @click="state.addLlm('api')" /><Button label="+ CLI in a terminal" severity="secondary" :disabled="state.busy" @click="state.addLlm('cli')" /><Button label="+ Claude Code" severity="secondary" :disabled="state.busy" @click="state.addLlm('claude-code')" /><Button label="+ Codex" severity="secondary" :disabled="state.busy" @click="state.addLlm('codex')" /></div>
    <small class="control-hint">API: a hosted or local model over an OpenAI-compatible API. CLI: an agent tool (Claude Code, Codex…) running in a terminal.</small>
    <section class="panel stack settings-panel" aria-label="MCP">
      <h2>MCP</h2>
      <div v-if="state.selectedPhone && selectedPhoneLlm?.kind === 'api'" class="stack">
        <h3>Client servers your agent connects to</h3>
        <McpServersEditor :servers="state.selectedPhone.mcpServers" :busy="state.busy" />
      </div>
      <AppTokensSection :phones="state.cfg.phones" :disabled="state.busy" />
    </section>
    <template v-if="state.selectedPhone">
      <PersonaSettings v-if="selectedUsesPersona" :phone="state.selectedPhone" :busy="state.busy" />
      <p v-else class="muted">Persona prompt settings are available when this phone uses an API, Claude Code, or Codex agent.</p>
    </template>
    <Button label="Save agent settings" :disabled="state.busy || !state.dirty" @click="state.save" />
  </div>
</template>
