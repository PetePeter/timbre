<script setup lang="ts">
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import FormField from './FormField.vue';
import type { PhoneEntry } from '../api';

defineProps<{ phone: PhoneEntry; busy: boolean }>();
</script>

<template>
  <section class="panel stack">
    <h2>Phone persona</h2>
    <p class="muted">These prompt settings apply to this phone's agent on the next call.</p>
    <div class="grid2">
      <label class="field"><span>Assistant name</span><FormField v-slot="{ inputAttrs }" :value="phone.line.persona.name" hint="No fixed length limit is enforced."><InputText v-model="phone.line.persona.name" v-bind="inputAttrs" :disabled="busy" /></FormField></label>
      <label class="field"><span>Tone</span><FormField v-slot="{ inputAttrs }" :value="phone.line.persona.tone" hint="Optional; no fixed length limit is enforced."><InputText v-model="phone.line.persona.tone" v-bind="inputAttrs" placeholder="Warm and concise" :disabled="busy" /></FormField></label>
    </div>
    <label class="field"><span>Instructions</span><FormField v-slot="{ inputAttrs }" :value="phone.line.persona.instructions" hint="Optional; no fixed length limit is enforced."><Textarea v-model="phone.line.persona.instructions" v-bind="inputAttrs" rows="3" :disabled="busy" /></FormField></label>
  </section>
</template>
