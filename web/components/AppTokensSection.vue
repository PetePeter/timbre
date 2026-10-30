<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type AppAction, type AppTokenMetadata, type PhoneEntry } from '../api';

const props = defineProps<{ phones: PhoneEntry[]; disabled?: boolean }>();
const actions: Array<{ id: AppAction; label: string }> = [
  { id: 'sms.send', label: 'Send SMS' },
  { id: 'records.read', label: 'Read records' },
  { id: 'search.read', label: 'Search records' },
  { id: 'contacts.read', label: 'Read contacts' },
  { id: 'contacts.write', label: 'Edit contacts' },
  { id: 'calls.create', label: 'Create calls' },
];
const name = ref('');
const phoneId = ref('*');
const selectedActions = ref<AppAction[]>(['records.read']);
const apps = ref<AppTokenMetadata[]>([]);
const newToken = ref('');
const error = ref('');
const busy = ref(false);

onMounted(() => { void load(); });

async function load(): Promise<void> {
  try {
    apps.value = (await api.appTokens()).items;
    error.value = '';
  } catch (err) { error.value = (err as Error).message; }
}

async function create(): Promise<void> {
  if (!name.value.trim() || !selectedActions.value.length) return;
  busy.value = true;
  newToken.value = '';
  error.value = '';
  try {
    const created = await api.createAppToken({ name: name.value.trim(), phoneIds: [phoneId.value], actions: selectedActions.value });
    newToken.value = created.token;
    name.value = '';
    await load();
  } catch (err) { error.value = (err as Error).message; }
  finally { busy.value = false; }
}

async function revoke(app: AppTokenMetadata): Promise<void> {
  busy.value = true;
  error.value = '';
  try { await api.revokeAppToken(app.id); await load(); }
  catch (err) { error.value = (err as Error).message; }
  finally { busy.value = false; }
}

function scopeLabel(app: AppTokenMetadata): string {
  if (app.phoneIds.includes('*')) return 'All phones';
  return props.phones.find((phone) => phone.id === app.phoneIds[0])?.name ?? app.phoneIds[0];
}
</script>

<template>
  <section class="panel stack settings-panel" :aria-busy="disabled || busy">
    <h2>Connected apps</h2>
    <p class="muted">Create scoped API tokens for trusted apps. A new token is shown once; copy it before closing this page.</p>

    <form class="stack" @submit.prevent="create">
      <label class="field"><span>Token name</span><input v-model="name" aria-label="Token name" maxlength="80" autocomplete="off" :disabled="disabled || busy" required /></label>
      <label class="field"><span>Phone access</span>
        <select v-model="phoneId" :disabled="disabled || busy">
          <option value="*">All phones</option>
          <option v-for="phone in phones" :key="phone.id" :value="phone.id">{{ phone.name }}</option>
        </select>
      </label>
      <fieldset class="stack" :disabled="disabled || busy">
        <legend>Allowed actions</legend>
        <label v-for="action in actions" :key="action.id" class="control-row">
          <span>{{ action.label }}</span><input v-model="selectedActions" type="checkbox" :value="action.id" :aria-label="`Allow ${action.label}`" />
        </label>
      </fieldset>
      <button type="submit" :disabled="disabled || busy || !name.trim() || !selectedActions.length">Create token</button>
    </form>

    <section v-if="newToken" class="stack" aria-label="New token">
      <p role="status">Copy this token now. It will not be shown again.</p>
      <code class="token-value" aria-label="New app token">{{ newToken }}</code>
      <button type="button" @click="newToken = ''">Hide token</button>
    </section>

    <p v-if="error" role="alert">{{ error }}</p>
    <ul v-if="apps.length" class="stack" aria-label="Connected app tokens">
      <li v-for="app in apps" :key="app.id" class="control-row">
        <span><strong>{{ app.name }}</strong><small>{{ scopeLabel(app) }} · {{ app.actions.join(', ') }}</small></span>
        <button type="button" :aria-label="`Revoke ${app.name}`" :disabled="disabled || busy" @click="revoke(app)">Revoke</button>
      </li>
    </ul>
    <p v-else class="muted">No app tokens.</p>
  </section>
</template>
