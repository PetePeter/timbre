<script setup lang="ts">
/**
 * The whole UI: phones (status + settings), LLMs, and web access. One layout
 * for desktop and phone: tabs on top, a single column that widens on desktop.
 * Edits are local until Save; status polls every 2 s.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, type LlmConfig, type PhoneStatus, type TimbreConfig } from './api';
import PhonePanel from './PhonePanel.vue';
import LlmPanel from './LlmPanel.vue';

type Tab = 'phones' | 'llms' | 'access';
const tab = ref<Tab>('phones');
const cfg = ref<TimbreConfig | null>(null);
const saved = ref('');
const status = ref<PhoneStatus[]>([]);
const error = ref('');
const busy = ref(false);

const dirty = computed(() => !!cfg.value && JSON.stringify(cfg.value) !== saved.value);

function adopt(next: TimbreConfig) {
  cfg.value = next;
  saved.value = JSON.stringify(next);
}

async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  error.value = '';
  try { await fn(); } catch (err) { error.value = (err as Error).message; } finally { busy.value = false; }
}

const save = () => run(async () => adopt(await api.save(cfg.value!)));
const addPhone = () => run(async () => { if (dirty.value) await save(); adopt(await api.addPhone()); });
const removePhone = (id: string) => run(async () => {
  if (!confirm('Remove this phone and its settings?')) return;
  adopt(await api.removePhone(id));
});

function addLlm(kind: LlmConfig['kind']) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  cfg.value!.llms.push(kind === 'api'
    ? { id, name: 'New API model', kind, baseUrl: 'http://127.0.0.1:8080/v1', model: '', apiKey: '' }
    : { id, name: 'New CLI', kind, command: 'claude', args: ['--mcp-config', '{mcpConfig}'], cwd: '' });
}

function removeLlm(id: string) {
  const c = cfg.value!;
  if (c.llms.length <= 1) return;
  c.llms = c.llms.filter((l) => l.id !== id);
}

let timer: ReturnType<typeof setInterval> | undefined;
const poll = () => api.status().then((s) => { status.value = s.phones; }).catch(() => undefined);
onMounted(async () => {
  await run(async () => adopt(await api.config()));
  void poll();
  timer = setInterval(poll, 2000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <header class="top">
    <h1>Timbre</h1>
    <nav class="tabs">
      <button v-for="t in (['phones', 'llms', 'access'] as Tab[])" :key="t" :class="{ on: tab === t }" @click="tab = t">
        {{ t === 'phones' ? 'Phones' : t === 'llms' ? 'LLMs' : 'Access' }}
      </button>
    </nav>
  </header>

  <main v-if="cfg" class="stack">
    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="tab === 'phones'">
      <PhonePanel
        v-for="p in cfg.phones" :key="p.id"
        :phone="p" :llms="cfg.llms" :status="status.find((s) => s.id === p.id)"
        :can-remove="cfg.phones.length > 1" :busy="busy" :dirty="dirty"
        @remove="removePhone(p.id)" @run="run"
      />
      <button :disabled="busy" @click="addPhone">+ Add phone</button>
    </template>

    <template v-else-if="tab === 'llms'">
      <LlmPanel v-for="l in cfg.llms" :key="l.id" :llm="l" :can-remove="cfg.llms.length > 1" @remove="removeLlm(l.id)" />
      <div class="row">
        <button @click="addLlm('api')">+ API model</button>
        <button @click="addLlm('cli')">+ CLI in a terminal</button>
      </div>
    </template>

    <section v-else class="panel stack">
      <h2>Web access</h2>
      <p class="muted">This computer can always open Timbre at localhost. Turn LAN access on to use it from a phone or another PC on your network; they need the access link once.</p>
      <label class="check"><input v-model="cfg.web.lan" type="checkbox" /> Allow LAN access</label>
      <label class="field"><span>Port</span><input v-model.number="cfg.web.port" type="number" min="1" max="65535" /></label>
      <p v-if="cfg.web.lan && cfg.web.token" class="muted">Access link: http://&lt;this-pc-ip&gt;:{{ cfg.web.port }}/?token={{ cfg.web.token }}</p>
      <p class="muted">Port and LAN changes apply when Timbre restarts.</p>
    </section>
  </main>

  <footer v-if="dirty" class="savebar">
    <span class="grow">Unsaved changes</span>
    <button @click="adopt(JSON.parse(saved))">Discard</button>
    <button class="primary" :disabled="busy" @click="save">Save</button>
  </footer>
</template>

<style scoped>
.top { position: sticky; top: 0; z-index: 1; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 12px 16px; background: var(--bg); border-bottom: 1px solid var(--line); }
.tabs { display: flex; gap: 6px; }
.tabs button.on { border-color: var(--accent); color: var(--accent); }
main { max-width: 900px; margin: 0 auto; padding: 16px 16px 96px; }
.savebar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 8px; align-items: center; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); background: var(--panel); border-top: 1px solid var(--line); }
</style>
