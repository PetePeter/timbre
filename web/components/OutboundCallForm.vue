<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

const phones = ref<Array<{ id: string; name: string }>>([]);
const phoneId = ref('');
const to = ref('');
const task = ref('');
const loadingPhones = ref(true);
const busy = ref(false);
const error = ref('');
const interactionId = ref('');

onMounted(async () => {
  try {
    phones.value = (await api.status()).phones.map(({ id, name }) => ({ id, name }));
    phoneId.value = phones.value[0]?.id ?? '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingPhones.value = false;
  }
});

async function submit(): Promise<void> {
  if (!phoneId.value) return;
  busy.value = true;
  error.value = '';
  interactionId.value = '';
  try {
    const result = await api.createCall(phoneId.value, { to: to.value, task: task.value });
    interactionId.value = result.interactionId;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="panel stack" aria-labelledby="call-for-me-title" :aria-busy="loadingPhones || busy">
    <div>
      <h2 id="call-for-me-title">Call for me</h2>
      <p class="muted">Ask the call agent to handle a call on your behalf.</p>
    </div>
    <p v-if="loadingPhones" class="muted">Loading phone lines…</p>
    <form v-else class="stack" @submit.prevent="submit">
      <label v-if="phones.length > 1" class="field">
        <span>Phone line</span>
        <select v-model="phoneId" name="phoneId" required>
          <option v-for="phone in phones" :key="phone.id" :value="phone.id">{{ phone.name }}</option>
        </select>
      </label>
      <label class="field">
        <span>To</span>
        <input v-model="to" name="to" type="text" autocomplete="tel" maxlength="120" required>
      </label>
      <label class="field">
        <span>Task</span>
        <textarea v-model="task" name="task" rows="3" maxlength="4000" required />
      </label>
      <p v-if="phones.length === 0" class="muted">Add a phone line before requesting a call.</p>
      <button class="p-button" type="submit" :disabled="busy || !phoneId">{{ busy ? 'Requesting…' : 'Call for me' }}</button>
    </form>
    <p v-if="interactionId" role="status">Call requested. Interaction ID: <code>{{ interactionId }}</code></p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.field input, .field select, .field textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); padding: 10px 12px; font: inherit; }
.field textarea { resize: vertical; }
</style>
