<script setup lang="ts">
import { ref } from 'vue';
import Button from 'primevue/button';
import { api } from '../api';
import type { TimbreConfig } from '../api';

defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ restored: [config: TimbreConfig] }>();
const includeRecords = ref(false);
const includeSecrets = ref(false);
const exportPassphrase = ref('');
const restorePassphrase = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const working = ref(false);
const error = ref('');
const status = ref('');
const download = ref<{ href: string; fileName: string } | null>(null);

async function createBackup() {
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
</script>

<template>
  <section class="panel stack backup-panel" :aria-busy="working || disabled">
    <div>
      <h2>Backup and restore</h2>
      <p class="muted">Save the full settings document and contacts. Secret credentials and caller PINs are excluded unless encrypted with a passphrase.</p>
      <p class="muted">Optional records include daily event history only. Transcripts, WAV audio, and custom transcript exports are not included. Voice files under dataDir/voices are not included; configured paths are saved.</p>
    </div>

    <label class="control-row" for="backup-records"><span>Include daily event history</span><input id="backup-records" v-model="includeRecords" type="checkbox" aria-label="Include daily event history" :disabled="working || disabled" /></label>
    <label class="control-row" for="backup-secrets"><span>Include secrets</span><input id="backup-secrets" v-model="includeSecrets" type="checkbox" aria-label="Include secrets" :disabled="working || disabled" /></label>
    <label v-if="includeSecrets" class="field" for="backup-export-passphrase"><span>Export passphrase</span><input id="backup-export-passphrase" v-model="exportPassphrase" type="password" minlength="8" autocomplete="new-password" aria-label="Export passphrase" :disabled="working || disabled" /></label>
    <div class="row">
      <Button label="Create backup" aria-label="Create backup" :disabled="working || disabled || (includeSecrets && exportPassphrase.length < 8)" @click="createBackup" />
      <a v-if="download" :href="download.href" :download="download.fileName" aria-label="Download backup">Download backup</a>
    </div>

    <hr />
    <label class="field" for="backup-file"><span>Backup file</span><input id="backup-file" ref="fileInput" type="file" accept=".json,application/json" aria-label="Backup file" :disabled="working || disabled" /></label>
    <label class="field" for="backup-restore-passphrase"><span>Restore passphrase</span><input id="backup-restore-passphrase" v-model="restorePassphrase" type="password" autocomplete="current-password" aria-label="Restore passphrase" :disabled="working || disabled" /></label>
    <Button label="Restore backup" aria-label="Restore backup" severity="secondary" :disabled="working || disabled" @click="restoreBackup" />
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <p v-if="status" class="muted" role="status">{{ status }}</p>
  </section>
</template>
