<script setup lang="ts">
import { ref } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import AppSelect from './AppSelect.vue';
import McpSecretMapEditor from './McpSecretMapEditor.vue';
import type { PhoneMcpServer } from '../../src/config/timbre-config';

const props = defineProps<{ server: PhoneMcpServer; index: number; busy: boolean }>();
const emit = defineEmits<{ remove: []; 'update:server': [server: PhoneMcpServer] }>();
const argsDraft = ref<string | null>(null);
const transportOptions = [
  { label: 'URL (HTTP)', value: 'http' },
  { label: 'Command (stdio)', value: 'command' },
];

function serverTransport(): 'http' | 'command' { return props.server.url !== undefined ? 'http' : 'command'; }

function setTransport(value: 'http' | 'command') {
  const server = { ...props.server };
  if (value === 'http') {
    delete server.command;
    delete server.args;
    delete server.cwd;
    delete server.env;
    server.url ??= '';
    server.headers ??= {};
  } else {
    delete server.url;
    delete server.headers;
    server.command ??= '';
    server.args ??= [];
    server.cwd ??= '';
    server.env ??= {};
  }
  emit('update:server', server);
}

function argsText(): string { return argsDraft.value ?? (props.server.args ?? []).join(' '); }
function updateArgsText(value: string) { argsDraft.value = value; }
function commitArgs() { updateServer({ args: argsText().split(/\s+/).filter(Boolean) }); }

function updateTools(value: string) {
  updateServer({ allowedTools: [...new Set(value.split(',').map((tool) => tool.trim()).filter(Boolean))] });
}

function updateHeaders(value: Record<string, string>) { updateServer({ headers: value }); }
function updateEnv(value: Record<string, string>) { updateServer({ env: value }); }

function updateServer(patch: Partial<PhoneMcpServer>) {
  emit('update:server', { ...props.server, ...patch });
}
</script>

<template>
  <article class="panel stack mcp-server">
    <div class="grid2">
      <label class="field"><span>Server name</span><InputText :model-value="props.server.name" :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} name`" @update:model-value="updateServer({ name: String($event ?? '') })" /></label>
      <label class="field"><span>Transport</span>
        <AppSelect :model-value="serverTransport()" :options="transportOptions" option-label="label" option-value="value" :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} transport`" @update:model-value="setTransport" />
      </label>
    </div>

    <div v-if="props.server.url !== undefined" class="stack">
      <label class="field"><span>Server URL</span><InputText :model-value="props.server.url" placeholder="https://…" :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} URL`" @update:model-value="updateServer({ url: String($event ?? '') })" /></label>
      <McpSecretMapEditor label="MCP header" :model-value="props.server.headers ?? {}" :busy="props.busy" @update:model-value="updateHeaders" />
    </div>
    <div v-if="props.server.command !== undefined" class="stack">
      <div class="grid2">
        <label class="field"><span>Command</span><InputText :model-value="props.server.command" :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} command`" @update:model-value="updateServer({ command: String($event ?? '') })" /></label>
        <label class="field"><span>Working folder (optional)</span><InputText :model-value="props.server.cwd" :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} working folder`" @update:model-value="updateServer({ cwd: String($event ?? '') })" /></label>
      </div>
      <label class="field"><span>Arguments (space separated)</span>
        <InputText :model-value="argsText()" :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} arguments`" @update:model-value="updateArgsText(String($event ?? ''))" @change="commitArgs" />
      </label>
      <McpSecretMapEditor label="MCP environment variable" :model-value="props.server.env ?? {}" :busy="props.busy" @update:model-value="updateEnv" />
    </div>

    <label class="field"><span>Allowed tools (comma separated)</span>
      <InputText :model-value="props.server.allowedTools.join(', ')" :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} allowed tools`" @update:model-value="updateTools(String($event ?? ''))" />
    </label>
    <Button severity="danger" outlined :disabled="props.busy" :aria-label="`Remove MCP server ${props.index + 1}`" @click="emit('remove')">Remove server</Button>
  </article>
</template>

<style scoped>
.mcp-server > .grid2 > * { min-width: 0; }
</style>
