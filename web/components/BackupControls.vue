<script setup lang="ts">
import { ref } from 'vue';
import Button from 'primevue/button';
import { api } from '../api';
import type { TimbreConfig } from '../api';
import FormField from './FormField.vue';
import InputText from 'primevue/inputtext';
import ServerFilePicker from './ServerFilePicker.vue';
import { backupPassphraseError } from '../field-validation';

defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ restored: [config: TimbreConfig] }>();
const includeRecords = ref(false);
const includeSecrets = ref(false);
const exportPassphrase = ref('');
const restorePassphrase = ref('');
const serverFolder = ref('');
const serverFile = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const working = ref(false);
const error = ref('');
const status = ref('');
const download = ref<{ href: string; fileName: string } | null>(null);

async function createBackup() {
  if (backupPassphraseError(exportPassphrase.value, includeSecrets.value)) return;
  working.value = true;
  error.value = '';
  status.value = '';
  download.value = null;
  try {
    const options = {
      includeRecords: includeRecords.value,
      includeSecrets: includeSecrets.value,
      ...(includeSecrets.value ? { passphrase: exportPassphrase.value } : {}),
    };
    const ticket = await api.createBackup(options);
    download.value = { href: api.backupDownloadUrl(ticket.ticket), fileName: ticket.fileName };
    if (includeSecrets.value) exportPassphrase.value = '';
    status.value = 'Backup ready to download.';
  } catch (err) { error.value = (err as Error).message; }
  finally { working.value = false; }
}

async function saveToServerFolder() {
  if (!serverFolder.value.trim() || backupPassphraseError(exportPassphrase.value, includeSecrets.value)) return;
  working.value = true;
  error.value = '';
  status.value = '';
  try {
    const options = {
      includeRecords: includeRecords.value,
      includeSecrets: includeSecrets.value,
      ...(includeSecrets.value ? { passphrase: exportPassphrase.value } : {}),
    };
    const saved = await api.saveServerBackup(serverFolder.value, options);
    if (includeSecrets.value) exportPassphrase.value = '';
    status.value = `Backup saved to ${saved.path}.`;
  } catch (err) { error.value = (err as Error).message; }
  finally { working.value = false; }
}

async function restoreBackup() {
  const file = fileInput.value?.files?.[0];
  if (!file) { error.value = 'Choose a backup file first.'; return; }
  working.value = true;
  error.value = '';
  status.value = '';
  try {
    const restored = await api.restoreBackup(file, restorePassphrase.value);
    emit('restored', restored.config);
    status.value = 'Backup restored.';
    restorePassphrase.value = '';
    if (fileInput.value) fileInput.value.value = '';
  } catch (err) { error.value = (err as Error).message; }
  finally { working.value = false; }
}

async function restoreServerFile() {
  if (!serverFile.value) { error.value = 'Choose a server backup file first.'; return; }
  working.value = true;
  error.value = '';
  status.value = '';
  try {
    const restored = await api.restoreServerBackup(serverFile.value, restorePassphrase.value);
    emit('restored', restored.config);
    status.value = 'Backup restored.';
    restorePassphrase.value = '';
  } catch (err) { error.value = (err as Error).message; }
  finally { working.value = false; }
}
</script>

<template>
  <section class="panel stack backup-panel" :aria-busy="working || disabled">
    <div>
      <h2>Backup and restore</h2>
      <p class="muted">Save the full settings document and contacts. Secret credentials and caller PINs are excluded unless encrypted with a passphrase.</p>
      <p class="muted">Optional records include daily event history only. Transcripts, WAV audio, and custom transcript exports are not included. Voice files under dataDir/voices are not included; configured paths are saved.</p>
    </div>

    <FormField v-slot="{ inputAttrs }" :value="includeRecords" hint="The server includes records when this is on." :block-save="false">
      <label class="control-row" for="backup-records"><span>Include daily event history</span><input id="backup-records" v-model="includeRecords" v-bind="inputAttrs" type="checkbox" aria-label="Include daily event history" :disabled="working || disabled" /></label>
    </FormField>
    <FormField v-slot="{ inputAttrs }" :value="includeSecrets" hint="When on, use an 8 to 1024 character passphrase." :block-save="false">
      <label class="control-row" for="backup-secrets"><span>Include secrets</span><input id="backup-secrets" v-model="includeSecrets" v-bind="inputAttrs" type="checkbox" aria-label="Include secrets" :disabled="working || disabled" /></label>
    </FormField>
    <label v-if="includeSecrets" class="field" for="backup-export-passphrase"><span>Export passphrase</span><FormField v-slot="{ inputAttrs }" :value="exportPassphrase" hint="A passphrase between 8 and 1024 characters is required to include secrets." :validate="(value) => backupPassphraseError(value, includeSecrets)" :attempted="includeSecrets" :block-save="false"><input id="backup-export-passphrase" v-model="exportPassphrase" v-bind="inputAttrs" type="password" minlength="8" maxlength="1024" autocomplete="new-password" aria-label="Export passphrase" :disabled="working || disabled" required /></FormField></label>
    <div class="row">
      <Button label="Create backup" aria-label="Create backup" :disabled="working || disabled || (includeSecrets && exportPassphrase.length < 8)" @click="createBackup" />
      <a v-if="download" :href="download.href" :download="download.fileName" aria-label="Download backup">Download backup</a>
    </div>

    <div class="field">
      <span><label for="backup-server-folder">Save to server folder</label></span>
      <div class="row">
        <FormField v-slot="{ inputAttrs }" :value="serverFolder" class="grow" hint="Choose a folder on the server PC, outside the Timbre application folder." :block-save="false"><InputText id="backup-server-folder" v-model="serverFolder" v-bind="inputAttrs" class="grow" readonly /></FormField>
        <ServerFilePicker mode="folder" :disabled="working || disabled" @select="serverFolder = $event" />
      </div>
    </div>
    <Button label="Save to server folder" :disabled="working || disabled || !serverFolder || (includeSecrets && exportPassphrase.length < 8)" @click="saveToServerFolder" />

    <hr />
    <label class="field" for="backup-file"><span>Backup file</span><FormField v-slot="{ inputAttrs }" hint="Choose a JSON backup file." :server-error="error === 'Choose a backup file first.' ? error : ''" :block-save="false"><input id="backup-file" ref="fileInput" v-bind="inputAttrs" type="file" accept=".json,application/json" aria-label="Backup file" :disabled="working || disabled" /></FormField></label>
    <label class="field" for="backup-restore-passphrase"><span>Restore passphrase</span><FormField v-slot="{ inputAttrs }" :value="restorePassphrase" hint="Required for encrypted backups; maximum 1024 characters." :validate="(value) => backupPassphraseError(value, false)" :server-error="error.toLowerCase().includes('passphrase') ? error : ''" :block-save="false"><input id="backup-restore-passphrase" v-model="restorePassphrase" v-bind="inputAttrs" type="password" maxlength="1024" autocomplete="current-password" aria-label="Restore passphrase" :disabled="working || disabled" /></FormField></label>
    <Button label="Restore backup" aria-label="Restore backup" severity="secondary" :disabled="working || disabled" @click="restoreBackup" />
    <div class="field">
      <span><label for="backup-server-file">Restore from server file</label></span>
      <div class="row">
        <FormField v-slot="{ inputAttrs }" :value="serverFile" class="grow" hint="Choose a JSON backup file on the server PC." :block-save="false"><InputText id="backup-server-file" v-model="serverFile" v-bind="inputAttrs" class="grow" readonly /></FormField>
        <ServerFilePicker extension=".json" :disabled="working || disabled" @select="serverFile = $event" />
      </div>
    </div>
    <Button label="Restore from server file" severity="secondary" :disabled="working || disabled || !serverFile" @click="restoreServerFile" />
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <p v-if="status" class="muted" role="status">{{ status }}</p>
  </section>
</template>
