<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import { McpClientSnippetBuilder } from '../mcp-client-snippet-builder';

type SnippetClient = 'claudeCode' | 'codex' | 'copilot';
type SnippetEntry = { client: SnippetClient; label: string; detail: string; code: string };

const props = withDefaults(defineProps<{
  title: string;
  endpointPath: string;
  token?: string;
  serverName?: string;
  presentation?: 'full' | 'copy-actions';
}>(), { serverName: 'timbre', presentation: 'full' });
const revealed = ref(false);
const copied = ref('');
const copyError = ref('');
const endpoint = computed(() => `${window.location.origin}${props.endpointPath}`);
const snippetBuilder = new McpClientSnippetBuilder();
const snippets = computed(() => props.token ? snippetBuilder.build(endpoint.value, props.token, props.serverName) : null);
const entries = computed(() => {
  const value = snippets.value;
  return value ? [
    { client: 'claudeCode', label: 'Claude Code · user scope', detail: 'Add this line in a terminal.', code: value.claudeCode },
    { client: 'codex', label: 'Codex · ~/.codex/config.toml', detail: 'Add this table to the user config file; Codex stores the bearer token here.', code: value.codex },
    { client: 'copilot', label: 'GitHub Copilot CLI · ~/.copilot/mcp-config.json', detail: 'Merge this object into the user mcpServers map; it stores the bearer token here.', code: value.copilot },
  ].filter((entry): entry is SnippetEntry => props.presentation === 'full' || entry.client !== 'copilot') : [];
});

watch(() => props.token, () => {
  revealed.value = false;
  copied.value = '';
  copyError.value = '';
});

function displaySnippet(code: string): string {
  return props.token && !revealed.value ? code.split(props.token).join('••••••••') : code;
}

async function copy(label: string, value: string): Promise<void> {
  try {
    await writeClipboard(value);
    copied.value = label;
    copyError.value = '';
  } catch {
    copied.value = '';
    copyError.value = 'Clipboard access is unavailable in this browser.';
  }
}

function setupCopyLabel(entry: SnippetEntry): string {
  if (props.presentation === 'full') return `Copy ${entry.label} setup`;
  return entry.client === 'claudeCode' ? 'Copy Claude Code setup line' : 'Copy Codex setup line';
}

function setupCopyText(entry: SnippetEntry): string {
  if (copied.value === entry.label) return 'Copied';
  return props.presentation === 'full' ? 'Copy setup' : setupCopyLabel(entry);
}

/** The async Clipboard API exists only on secure origins (localhost/HTTPS); LAN pages need the legacy path. */
async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard) {
    try { return await navigator.clipboard.writeText(value); } catch { /* fall through to legacy copy */ }
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(area);
  try {
    area.select();
    if (!document.execCommand('copy')) throw new Error('copy refused');
  } finally {
    area.remove();
  }
}
</script>

<template>
  <section class="stack mcp-connection" :aria-label="title">
    <h3 v-if="presentation === 'full'">{{ title }}</h3>
    <div v-if="presentation === 'full'" class="row mcp-connection-value">
      <span class="mcp-connection-label">MCP URL</span>
      <code class="grow mcp-break">{{ endpoint }}</code>
      <Button severity="secondary" aria-label="Copy MCP URL" @click="copy('MCP URL', endpoint)">{{ copied === 'MCP URL' ? 'Copied' : 'Copy URL' }}</Button>
    </div>
    <template v-if="token">
      <div v-if="presentation === 'full'" class="row mcp-connection-value">
        <span class="mcp-connection-label">Bearer token</span>
        <code class="grow mcp-break" aria-label="MCP bearer token">{{ revealed ? token : '••••••••' }}</code>
        <Button severity="secondary" :aria-label="revealed ? 'Hide MCP token' : 'Reveal MCP token'" @click="revealed = !revealed">{{ revealed ? 'Hide' : 'Reveal' }}</Button>
        <Button severity="secondary" aria-label="Copy MCP token" @click="copy('MCP token', token)">{{ copied === 'MCP token' ? 'Copied' : 'Copy token' }}</Button>
      </div>
      <Button v-if="presentation === 'copy-actions'" severity="secondary" aria-label="Copy token" @click="copy('MCP token', token)">{{ copied === 'MCP token' ? 'Copied' : 'Copy token' }}</Button>
      <div v-for="entry in entries" :key="entry.label" class="stack mcp-snippet">
        <div class="row"><strong v-if="presentation === 'full'" class="grow">{{ entry.label }}</strong><Button severity="secondary" :aria-label="setupCopyLabel(entry)" @click="copy(entry.label, entry.code)">{{ setupCopyText(entry) }}</Button></div>
        <small v-if="presentation === 'full'" class="muted">{{ entry.detail }}</small>
        <pre v-if="presentation === 'full'">{{ displaySnippet(entry.code) }}</pre>
      </div>
    </template>
    <p v-else-if="presentation === 'full'" class="muted">Create an app token to generate client setup snippets.</p>
    <p v-if="copyError" role="alert">{{ copyError }}</p>
  </section>
</template>

<style scoped>
.mcp-connection { min-width: 0; }
.mcp-connection-value { align-items: center; flex-wrap: wrap; }
.mcp-connection-label { min-width: 105px; }
.mcp-break { overflow-wrap: anywhere; }
.mcp-snippet { min-width: 0; }
.mcp-snippet pre { margin: 0; padding: .75rem; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
