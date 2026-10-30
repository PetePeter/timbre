<script setup lang="ts">
import Button from 'primevue/button';
import McpServerEditor from './McpServerEditor.vue';
import type { PhoneMcpServer } from '../../src/config/timbre-config';

const props = defineProps<{ servers: PhoneMcpServer[]; busy: boolean }>();

function addServer() {
  const used = new Set(props.servers.map((server) => server.name));
  let name = `server${props.servers.length + 1}`;
  while (used.has(name)) name = `${name}_`;
  const id = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  props.servers.push({ id, name, url: '', headers: {}, allowedTools: [] });
}

function updateServer(index: number, server: PhoneMcpServer) { props.servers.splice(index, 1, server); }
</script>

<template>
  <section class="stack mcp-servers" aria-label="External MCP servers">
    <h3>External MCP servers</h3>
    <McpServerEditor
      v-for="(server, index) in props.servers"
      :key="server.id ?? index"
      :server="server"
      :index="index"
      :existing-names="props.servers.filter((_item, otherIndex) => otherIndex !== index).map((item) => item.name)"
      :busy="props.busy"
      @update:server="updateServer(index, $event)"
      @remove="props.servers.splice(index, 1)"
    />
    <Button severity="secondary" :disabled="props.busy" aria-label="Add MCP server" @click="addServer">+ MCP server</Button>
  </section>
</template>
