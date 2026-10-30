<script setup lang="ts">
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import type { PhoneEntry } from '../api';

defineProps<{ phone: PhoneEntry; busy: boolean }>();
</script>

<template>
  <section class="panel stack">
    <h2>Phone persona</h2>
    <p class="muted">These prompt settings apply to API agents on the next call.</p>
    <div class="grid2">
      <label class="field"><span>Assistant name</span><InputText v-model="phone.line.persona.name" :disabled="busy" /></label>
      <label class="field"><span>Tone</span><InputText v-model="phone.line.persona.tone" placeholder="Warm and concise" :disabled="busy" /></label>
    </div>
    <label class="field"><span>Instructions</span><Textarea v-model="phone.line.persona.instructions" rows="3" :disabled="busy" /></label>
  </section>
</template>
