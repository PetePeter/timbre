<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type AppAction, type AppTokenMetadata, type PhoneEntry } from '../api';
import FormField from './FormField.vue';
import { appTokenActionsError, appTokenNameError } from '../field-validation';

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
const attempted = ref(false);

onMounted(() => { void load(); });

async function load(): Promise<void> {
  try {
    apps.value = (await api.appTokens()).items;
    error.value = '';
  } catch (err) { error.value = (err as Error).message; }
}

async function create(): Promise<void> {
  attempted.value = true;
  if (appTokenNameError(name.value) || appTokenActionsError(selectedActions.value)) return;
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

    <form class="stack" novalidate @submit.prevent="create">
      <label class="field"><span>Token name</span><FormField v-slot="{ inputAttrs }" :value="name" hint="Token name must be 1 to 80 characters." :validate="appTokenNameError" :server-error="error.startsWith('Token name') ? error : ''" :attempted="attempted" :block-save="false"><input v-model="name" v-bind="inputAttrs" aria-label="Token name" minlength="1" maxlength="80" autocomplete="off" :disabled="disabled || busy" required /></FormField></label>
      <label class="field"><span>Phone access</span>
        <FormField v-slot="{ inputAttrs }" :value="phoneId" hint="Choose one phone or all phones." :block-save="false">
          <select v-model="phoneId" v-bind="inputAttrs" :disabled="disabled || busy">
            <option value="*">All phones</option>
            <option v-for="phone in phones" :key="phone.id" :value="phone.id">{{ phone.name }}</option>
          </select>
        </FormField>
      </label>
      <FormField v-slot="{ inputAttrs }" :value="selectedActions" hint="Choose at least one valid action." :validate="appTokenActionsError" :attempted="attempted" :block-save="false">
        <fieldset class="stack" :disabled="disabled || busy" v-bind="inputAttrs">
          <legend>Allowed actions</legend>
          <label v-for="action in actions" :key="action.id" class="control-row">
            <span>{{ action.label }}</span><input v-model="selectedActions" type="checkbox" :value="action.id" :aria-label="`Allow ${action.label}`" />
          </label>
        </fieldset>
      </FormField>
      <button type="submit" :disabled="disabled || busy">Create token</button>
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
