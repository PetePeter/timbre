<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../api';
import McpConnectionDetails from './McpConnectionDetails.vue';

const props = defineProps<{ phoneId: string }>();
const token = ref('');
const error = ref('');
const loading = ref(false);

watch(() => props.phoneId, (phoneId, _previous, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  token.value = '';
  error.value = '';
  loading.value = true;
  void api.phoneMcpConnection(phoneId)
    .then((connection) => { if (current) token.value = connection.token; })
    .catch((cause) => { if (current) error.value = (cause as Error).message; })
    .finally(() => { if (current) loading.value = false; });
}, { immediate: true });
</script>

<template>
  <div class="stack">
    <template v-if="token">
      <p class="muted">This phone token is held in memory and changes when Timbre restarts. Refresh the copied client settings after a restart. For a permanent user-level setup, use an app token from Settings instead.</p>
      <McpConnectionDetails title="Phone MCP server" :endpoint-path="`/mcp/${encodeURIComponent(phoneId)}`" :server-name="`timbre-${phoneId}`" :token="token" />
    </template>
    <p v-else-if="loading" class="muted">Loading this phone's MCP connection…</p>
    <p v-else role="alert">Phone MCP connection unavailable: {{ error }}</p>
  </div>
</template>
