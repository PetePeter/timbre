<script setup lang="ts">
import { computed } from 'vue';
import Button from 'primevue/button';
import LlmPanel from '../LlmPanel.vue';
import PersonaSettings from '../components/PersonaSettings.vue';
import VoiceSettings from '../components/VoiceSettings.vue';
import { useAppState } from '../app-state';
import type { LlmConfig } from '../api';
const state = useAppState();
const selectedUsesApi = computed(() => state.cfg?.llms.find((llm) => llm.id === state.selectedPhone?.llmId)?.kind === 'api');

function updateArgs(llm: LlmConfig, args: string[]) {
  if (llm.kind === 'cli') llm.args = args;
}
</script>
<template>
  <div class="page-heading"><div><h1>Agent</h1><p>Who answers your phones, and how they connect.</p></div></div>
  <div v-if="state.cfg" class="stack">
    <LlmPanel v-for="llm in state.cfg.llms" :key="llm.id" :llm="llm" :can-remove="state.cfg.llms.length > 1" :busy="state.busy" @remove="state.removeLlm(llm.id)" @update:args="updateArgs(llm, $event)" />
    <div class="row"><Button label="+ API model" :disabled="state.busy" @click="state.addLlm('api')" /><Button label="+ CLI in a terminal" severity="secondary" :disabled="state.busy" @click="state.addLlm('cli')" /></div>
    <template v-if="state.selectedPhone">
      <VoiceSettings :phone="state.selectedPhone" :busy="state.busy" :run="state.run" @update:custom-piper-models="state.cfg.customPiperModels = $event" />
      <PersonaSettings v-if="selectedUsesApi" :phone="state.selectedPhone" :busy="state.busy" />
      <p v-else class="muted">Persona prompt settings are available when this phone uses an API agent.</p>
    </template>
    <Button label="Save agent settings" :disabled="state.busy || !state.dirty" @click="state.save" />
  </div>
</template>
