<script setup lang="ts">
import { ref } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import AppSelect from './AppSelect.vue';
import McpSecretMapEditor from './McpSecretMapEditor.vue';
import type { PhoneMcpServer } from '../../src/config/timbre-config';
import FormField from './FormField.vue';
import ServerFilePicker from './ServerFilePicker.vue';
import { mcpServerNameError, mcpUrlError, requiredMcpCommandError } from '../field-validation';

const props = withDefaults(defineProps<{ server: PhoneMcpServer; index: number; busy: boolean; existingNames?: string[] }>(), { existingNames: () => [] });
const emit = defineEmits<{ remove: []; 'update:server': [server: PhoneMcpServer] }>();
const argsDraft = ref<string | null>(null);
const transportOptions = [
  { label: 'URL (HTTP)', value: 'http' },
  { label: 'Command (stdio)', value: 'command' },
];
const serverUrlPlaceholder = 'https://…';

function serverTransport(): 'http' | 'command' { return props.server.url !== undefined ? 'http' : 'command'; }
const nameError = (value: unknown) => mcpServerNameError(value, props.existingNames);

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
      <label class="field"><span>Server name</span><FormField v-slot="{ inputAttrs }" :value="props.server.name" hint="Server name must start with a letter or digit and use only letters, digits, ., _, or -. Names must be unique." :validate="nameError"><InputText :model-value="props.server.name" v-bind="inputAttrs" pattern="[A-Za-z0-9][A-Za-z0-9_.-]*" required :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} name`" @update:model-value="updateServer({ name: String($event ?? '') })" /></FormField></label>
      <label class="field"><span>Transport</span>
        <FormField v-slot="{ inputAttrs }" :value="serverTransport()" hint="Choose an HTTP URL or a local command."><AppSelect :model-value="serverTransport()" v-bind="inputAttrs" :options="transportOptions" option-label="label" option-value="value" :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} transport`" @update:model-value="setTransport" /></FormField>
      </label>
    </div>

    <div v-if="props.server.url !== undefined" class="stack">
      <label class="field"><span>Server URL</span><FormField v-slot="{ inputAttrs }" :value="props.server.url" hint="Enter an absolute http:// or https:// URL." :validate="mcpUrlError"><InputText type="url" :model-value="props.server.url" v-bind="inputAttrs" :placeholder="serverUrlPlaceholder" required :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} URL`" @update:model-value="updateServer({ url: String($event ?? '') })" /></FormField></label>
      <McpSecretMapEditor label="MCP header" :model-value="props.server.headers ?? {}" :busy="props.busy" @update:model-value="updateHeaders" />
    </div>
    <div v-if="props.server.command !== undefined" class="stack">
      <div class="grid2">
        <div class="field">
          <span><label :for="`mcp-command-${props.index}`">Command</label></span>
          <div class="row">
            <FormField v-slot="{ inputAttrs }" :value="props.server.command" class="grow" hint="Command is required for stdio transport." :validate="requiredMcpCommandError"><InputText :id="`mcp-command-${props.index}`" :model-value="props.server.command" v-bind="inputAttrs" class="grow" required :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} command`" @update:model-value="updateServer({ command: String($event ?? '') })" /></FormField>
            <ServerFilePicker :disabled="props.busy" @select="updateServer({ command: $event })" />
          </div>
        </div>
        <div class="field">
          <span><label :for="`mcp-cwd-${props.index}`">Working folder (optional)</label></span>
          <div class="row">
            <FormField v-slot="{ inputAttrs }" :value="props.server.cwd" class="grow" hint="Optional; no fixed length limit is enforced."><InputText :id="`mcp-cwd-${props.index}`" :model-value="props.server.cwd" v-bind="inputAttrs" class="grow" :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} working folder`" @update:model-value="updateServer({ cwd: String($event ?? '') })" /></FormField>
            <ServerFilePicker mode="folder" :disabled="props.busy" @select="updateServer({ cwd: $event })" />
          </div>
        </div>
      </div>
      <label class="field"><span>Arguments (space separated)</span>
        <FormField v-slot="{ inputAttrs }" :value="argsText()" hint="Arguments are split on whitespace; no fixed length limit is enforced."><InputText :model-value="argsText()" v-bind="inputAttrs" :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} arguments`" @update:model-value="updateArgsText(String($event ?? ''))" @change="commitArgs" /></FormField>
      </label>
      <McpSecretMapEditor label="MCP environment variable" :model-value="props.server.env ?? {}" :busy="props.busy" @update:model-value="updateEnv" />
    </div>

    <label class="field"><span>Allowed tools (comma separated)</span>
      <FormField v-slot="{ inputAttrs }" :value="props.server.allowedTools.join(', ')" hint="Use comma-separated tool names; unknown or unavailable tools are ignored."><InputText :model-value="props.server.allowedTools.join(', ')" v-bind="inputAttrs" :disabled="props.busy" :aria-label="`MCP server ${props.index + 1} allowed tools`" @update:model-value="updateTools(String($event ?? ''))" /></FormField>
    </label>
    <Button severity="danger" outlined :disabled="props.busy" :aria-label="`Remove MCP server ${props.index + 1}`" @click="emit('remove')">Remove server</Button>
  </article>
</template>

<style scoped>
.mcp-server > .grid2 > * { min-width: 0; }
</style>
