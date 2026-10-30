<script setup lang="ts">
import { computed, ref } from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { api, type ServerFileEntry, type ServerFileListing } from '../api';
import { useThemeOverlayProps } from '../theme-overlay';

const props = withDefaults(defineProps<{ extension?: string; disabled?: boolean; mode?: 'file' | 'folder' }>(), { disabled: false, mode: 'file' });
const emit = defineEmits<{ select: [path: string] }>();
const overlayProps = useThemeOverlayProps();
const visible = ref(false);
const loading = ref(false);
const error = ref('');
const listing = ref<ServerFileListing | null>(null);

interface Breadcrumb { label: string; path: string }

const entries = computed(() => {
  if (!listing.value) return [];
  const items = listing.value.path
    ? listing.value.entries
    : listing.value.roots.map((root): ServerFileEntry => ({ name: root, isDir: true, size: 0 }));
  return [...items.filter((entry) => props.mode !== 'folder' || entry.isDir)].sort((left, right) => Number(right.isDir) - Number(left.isDir)
    || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
});

const breadcrumbs = computed(() => makeBreadcrumbs(listing.value?.path ?? ''));

function makeBreadcrumbs(value: string): Breadcrumb[] {
  if (!value) return [];
  const separator = value.includes('\\') ? '\\' : '/';
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(value);
  const drive = /^([a-z]:)[\\/]/i.exec(value);
  let root: string;
  let remaining: string;
  let rootLabel: string;

  if (unc) {
    rootLabel = `${unc[1]}/${unc[2]}`;
    root = `${separator}${separator}${unc[1]}${separator}${unc[2]}${separator}`;
    remaining = value.slice(unc[0].length);
  } else if (drive) {
    rootLabel = drive[1];
    root = `${drive[1]}${separator}`;
    remaining = value.slice(drive[0].length);
  } else {
    root = separator;
    rootLabel = root;
    remaining = value.slice(1);
  }

  const result: Breadcrumb[] = [{ label: rootLabel, path: root }];
  let current = root;
  for (const segment of remaining.split(/[\\/]+/).filter(Boolean)) {
    current = current.endsWith(separator) ? `${current}${segment}` : `${current}${separator}${segment}`;
    result.push({ label: segment, path: current });
  }
  return result;
}

function joinPath(directory: string, name: string): string {
  if (!directory) return name;
  if (directory.endsWith('/') || directory.endsWith('\\')) return `${directory}${name}`;
  return `${directory}${directory.includes('\\') ? '\\' : '/'}${name}`;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function load(directory?: string): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    listing.value = await api.serverFiles(directory, props.extension);
  } catch (cause) {
    error.value = (cause as Error).message || 'Unable to list this folder.';
  } finally {
    loading.value = false;
  }
}

async function openPicker(): Promise<void> {
  visible.value = true;
  await load();
}

async function navigate(directory: string): Promise<void> {
  await load(directory);
}

function activate(entry: ServerFileEntry): void {
  const currentPath = listing.value?.path ?? '';
  const absolutePath = joinPath(currentPath, entry.name);
  if (entry.isDir) {
    void navigate(absolutePath);
    return;
  }
  emit('select', absolutePath);
  visible.value = false;
}

function selectCurrentFolder(): void {
  const directory = listing.value?.path;
  if (!directory || loading.value || error.value) return;
  emit('select', directory);
  visible.value = false;
}

function setVisible(value: boolean): void {
  visible.value = value;
}
</script>

<template>
  <Button label="Browse" severity="secondary" :disabled="disabled" @click="openPicker" />
  <Dialog v-bind="overlayProps" :visible="visible" modal :draggable="false" class="server-file-picker" :header="props.mode === 'folder' ? 'Choose a server folder' : 'Choose a server file'" @update:visible="setVisible">
    <div class="stack">
      <nav v-if="breadcrumbs.length" class="row file-breadcrumbs" aria-label="Folder path">
        <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
          <Button text severity="secondary" :disabled="loading" @click="navigate(crumb.path)">{{ crumb.label }}</Button>
          <span v-if="index < breadcrumbs.length - 1" class="muted" aria-hidden="true">/</span>
        </template>
      </nav>
      <div v-if="listing && listing.path && listing.roots.length > 1" class="row">
        <Button label="All drives" text severity="secondary" :disabled="loading" @click="navigate('')" />
      </div>
      <div v-if="listing?.parentPath" class="row">
        <Button label="Up one folder" text severity="secondary" :disabled="loading" @click="navigate(listing.parentPath)" />
      </div>
      <p v-if="props.extension && props.mode === 'file'" class="muted">Folders and {{ props.extension }} files are shown.</p>
      <p v-else-if="props.mode === 'folder'" class="muted">Choose a folder to use.</p>
      <p v-if="loading" class="muted" role="status">Loading folder…</p>
      <p v-else-if="error" class="error-banner" role="alert">{{ error }}</p>
      <p v-else-if="listing?.truncated" class="muted" role="status">Showing the first 1000 entries.</p>
      <p v-if="!loading && !error && entries.length === 0" class="muted">{{ props.mode === 'folder' ? 'No folders here.' : 'No files or folders here.' }}</p>
      <ul v-if="!loading && !error" class="server-file-entries">
        <li v-for="entry in entries" :key="entry.name">
          <button class="server-file-entry" type="button" :disabled="loading" @click="activate(entry)">
            <span class="grow">{{ entry.name }}</span>
            <small class="muted">{{ entry.isDir ? 'Folder' : formatSize(entry.size) }}</small>
          </button>
        </li>
      </ul>
    </div>
    <template #footer>
      <div class="row file-picker-footer">
        <span class="muted grow">{{ listing?.path || 'Choose a drive' }}</span>
        <Button v-if="props.mode === 'folder'" label="Use this folder" aria-label="Use this folder" :disabled="loading || !!error || !listing?.path" @click="selectCurrentFolder" />
        <Button label="Close" severity="secondary" @click="setVisible(false)" />
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.server-file-picker { width: min(42rem, 92vw); }
.file-breadcrumbs { gap: 4px; }
.server-file-entries { display: grid; gap: 6px; max-height: 48vh; overflow: auto; list-style: none; margin: 0; padding: 0; }
.server-file-entry { display: flex; align-items: center; gap: 12px; width: 100%; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text); padding: 10px 12px; text-align: left; cursor: pointer; }
.server-file-entry:hover:not(:disabled) { background: var(--soft); }
.server-file-entry:disabled { cursor: wait; opacity: .6; }
.file-picker-footer { width: 100%; }
</style>
