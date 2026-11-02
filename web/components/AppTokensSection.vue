<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type AppAction, type AppTokenMetadata, type PhoneEntry } from '../api';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import FormField from './FormField.vue';
import { appTokenActionsError, appTokenNameError } from '../field-validation';
import McpConnectionDetails from './McpConnectionDetails.vue';
import AppTokenAccessFields from './AppTokenAccessFields.vue';
import { useThemeOverlayProps } from '../theme-overlay';

const props = defineProps<{ phones: PhoneEntry[]; disabled?: boolean }>();
const overlayProps = useThemeOverlayProps();
const name = ref('');
const phoneId = ref('*');
const selectedActions = ref<AppAction[]>(['sms.list']);
const apps = ref<AppTokenMetadata[]>([]);
const newToken = ref('');
const newTokenName = ref('');
const tokenDialogVisible = ref(false);
const editingApp = ref<AppTokenMetadata | null>(null);
const editingPhoneId = ref('*');
const editingActions = ref<AppAction[]>([]);
const configureDialogVisible = ref(false);
const configureAttempted = ref(false);
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
  newTokenName.value = '';
  tokenDialogVisible.value = false;
  error.value = '';
  try {
    const created = await api.createAppToken({ name: name.value.trim(), phoneIds: [phoneId.value], actions: selectedActions.value });
    newToken.value = created.token;
    newTokenName.value = created.app.name;
    tokenDialogVisible.value = true;
    name.value = '';
    await load();
  } catch (err) { error.value = (err as Error).message; }
  finally { busy.value = false; }
}

function setTokenDialogVisible(visible: boolean): void {
  tokenDialogVisible.value = visible;
  if (!visible) {
    newToken.value = '';
    newTokenName.value = '';
  }
}

function configure(app: AppTokenMetadata): void {
  editingApp.value = app;
  editingPhoneId.value = app.phoneIds[0] ?? '*';
  editingActions.value = [...app.actions];
  configureAttempted.value = false;
  configureDialogVisible.value = true;
}

function setConfigureDialogVisible(visible: boolean): void {
  configureDialogVisible.value = visible;
  if (!visible) {
    editingApp.value = null;
    editingActions.value = [];
  }
}

async function saveConfiguration(): Promise<void> {
  configureAttempted.value = true;
  if (!editingApp.value || appTokenActionsError(editingActions.value)) return;
  busy.value = true;
  error.value = '';
  try {
    await api.updateAppToken(editingApp.value.id, {
      phoneIds: [editingPhoneId.value],
      actions: editingActions.value,
    });
    setConfigureDialogVisible(false);
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
  <div class="stack" :aria-busy="disabled || busy">
    <h3>Server apps that connect to Timbre</h3>
    <p class="muted">Applies to all phones.</p>
    <p class="muted">Create a scoped app token for trusted MCP clients. The token is shown once.</p>

    <form class="stack" novalidate @submit.prevent="create">
      <label class="field"><span>Token name</span><FormField v-slot="{ inputAttrs }" :value="name" hint="Token name must be 1 to 80 characters." :validate="appTokenNameError" :server-error="error.startsWith('Token name') ? error : ''" :attempted="attempted" :block-save="false"><input v-model="name" v-bind="inputAttrs" aria-label="Token name" minlength="1" maxlength="80" autocomplete="off" :disabled="disabled || busy" required /></FormField></label>
      <AppTokenAccessFields v-model:phone-id="phoneId" v-model:actions="selectedActions" :phones="phones" :disabled="disabled || busy" :attempted="attempted" />
      <Button type="submit" label="Create token" :disabled="disabled || busy" />
    </form>

    <Dialog v-bind="overlayProps" :visible="tokenDialogVisible" modal :draggable="false" class="app-token-dialog" :header="newTokenName" :close-button-props="{ 'aria-label': 'Close token details' }" @update:visible="setTokenDialogVisible">
      <p class="muted" role="status">This token is shown once. Copy the token or a setup line now; closing this dialog clears it.</p>
      <McpConnectionDetails title="App MCP setup" endpoint-path="/mcp" :token="newToken || undefined" presentation="copy-actions" />
    </Dialog>
    <Dialog v-bind="overlayProps" :visible="configureDialogVisible" modal :draggable="false" class="app-token-dialog" :header="editingApp ? 'Configure ' + editingApp.name : 'Configure token'" :close-button-props="{ 'aria-label': 'Close token configuration' }" @update:visible="setConfigureDialogVisible">
      <p class="muted">Update this token's phone access and allowed actions. Its key stays the same.</p>
      <form class="stack" novalidate @submit.prevent="saveConfiguration">
        <AppTokenAccessFields v-model:phone-id="editingPhoneId" v-model:actions="editingActions" :phones="phones" :disabled="disabled || busy" :attempted="configureAttempted" />
        <Button type="submit" label="Save changes" :disabled="disabled || busy" />
      </form>
    </Dialog>

    <p v-if="error" role="alert">{{ error }}</p>
    <ul v-if="apps.length" class="stack" aria-label="Connected app tokens">
      <li v-for="app in apps" :key="app.id" class="control-row">
        <span><strong>{{ app.name }}</strong><small>{{ scopeLabel(app) }} · {{ app.actions.join(', ') }}</small></span>
        <Button type="button" label="Configure" :aria-label="'Configure ' + app.name" :disabled="disabled || busy" @click="configure(app)" />
        <Button type="button" label="Revoke" severity="danger" outlined :aria-label="'Revoke ' + app.name" :disabled="disabled || busy" @click="revoke(app)" />
      </li>
    </ul>
    <p v-else class="muted">No app tokens.</p>
  </div>
</template>
