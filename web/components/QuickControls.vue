<script setup lang="ts">
import SelectButton from 'primevue/selectbutton';
import type { InboundMode, UnknownCallerMode } from '../../src/phone/phone-config.js';
import { useAppState } from '../app-state';

const state = useAppState();
const modeOptions = [
  { label: 'Normal', value: 'normal' },
  { label: 'Busy', value: 'busy' },
  { label: 'DND', value: 'dnd' },
];
const unknownOptions = [
  { label: 'Allow', value: 'allow' },
  { label: 'Screen', value: 'screen' },
  { label: 'Block', value: 'block' },
];
const privateOptions = [
  { label: 'Allow', value: 'allow' },
  { label: 'Block', value: 'block' },
];

function updateMode(value: unknown) {
  const phone = state.selectedPhone;
  if (!phone || state.busy || !modeOptions.some((option) => option.value === value)) return;
  phone.line.inboundMode = value as InboundMode;
  void state.save();
}

function updateUnknownCallers(value: unknown) {
  const phone = state.selectedPhone;
  if (!phone || state.busy || !unknownOptions.some((option) => option.value === value)) return;
  phone.line.screening.unknownCallers = value as UnknownCallerMode;
  void state.save();
}

function updatePrivateNumbers(value: unknown) {
  const phone = state.selectedPhone;
  if (!phone || state.busy || !privateOptions.some((option) => option.value === value)) return;
  phone.line.screening.acceptPrivate = value === 'allow';
  void state.save();
}
</script>

<template>
  <section class="panel quick-controls">
    <div class="section-heading"><h2>Quick controls</h2><span v-if="state.busy" class="muted small" role="status">Saving…</span></div>
    <div class="quick-control">
      <span>Mode<small>Normal: your call rules apply, the AI answers by default. Busy: the AI only takes a message. DND: calls are declined.</small></span>
      <SelectButton :model-value="state.selectedPhone?.line.inboundMode" :options="modeOptions" option-label="label" option-value="value" :disabled="state.busy || !state.selectedPhone" aria-label="Inbound mode" @update:model-value="updateMode" />
    </div>
    <div class="quick-control">
      <span>Unknown callers<small>Numbers not in your contacts. Screen: the AI asks who is calling first.</small></span>
      <SelectButton :model-value="state.selectedPhone?.line.screening.unknownCallers" :options="unknownOptions" option-label="label" option-value="value" :disabled="state.busy || !state.selectedPhone" aria-label="Unknown callers" @update:model-value="updateUnknownCallers" />
    </div>
    <div class="quick-control">
      <span>Private numbers<small>Calls with a hidden caller ID.</small></span>
      <SelectButton :model-value="state.selectedPhone?.line.screening.acceptPrivate ? 'allow' : 'block'" :options="privateOptions" option-label="label" option-value="value" :disabled="state.busy || !state.selectedPhone" aria-label="Private numbers" @update:model-value="updatePrivateNumbers" />
    </div>
    <div class="control-row"><span>Agent</span><span class="pill sky">{{ state.cfg?.llms.find((llm) => llm.id === state.selectedPhone?.llmId)?.name || 'Not set' }}</span></div>
    <p v-if="state.error" class="error small" role="alert">{{ state.error }}</p>
  </section>
</template>
