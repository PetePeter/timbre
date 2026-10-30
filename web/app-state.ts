import { computed, inject, onMounted, onUnmounted, provide, reactive, ref, type InjectionKey } from 'vue';
import { api, type LlmConfig, type PhoneStatus, type TimbreConfig } from './api';

function createEditor() {
  const cfg = ref<TimbreConfig | null>(null);
  const saved = ref('');
  const busy = ref(false);
  const error = ref('');
  const dirty = computed(() => !!cfg.value && JSON.stringify(cfg.value) !== saved.value);
  const adopt = (next: TimbreConfig) => { cfg.value = next; saved.value = JSON.stringify(next); };
  const discard = () => { if (saved.value) adopt(JSON.parse(saved.value)); };

  async function run(fn: () => Promise<unknown>) {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    try { await fn(); } catch (err) { error.value = (err as Error).message; } finally { busy.value = false; }
  }

  const save = () => run(async () => { if (cfg.value) adopt(await api.save(cfg.value)); });
  const addPhone = () => run(async () => {
    if (dirty.value && cfg.value) adopt(await api.save(cfg.value));
    adopt(await api.addPhone());
  });
  const removePhone = (id: string) => run(async () => {
    if (confirm('Remove this phone and its settings?')) adopt(await api.removePhone(id));
  });

  function addLlm(kind: LlmConfig['kind'] | 'claude-code') {
    if (!cfg.value || busy.value) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    cfg.value.llms.push(kind === 'api'
      ? { id, name: 'New API model', kind, baseUrl: 'http://127.0.0.1:8080/v1', model: '', apiKey: '', mode: 'handover', dailyTokenLimit: 0 }
      : kind === 'claude-code'
        ? { id, name: 'Claude Code', kind: 'cli', command: 'claude', args: [], cwd: '', preset: 'claude-code', extraAllowedTools: [] }
        : { id, name: 'New CLI', kind, command: 'claude', args: ['--mcp-config', '{mcpConfig}'], cwd: '' });
  }

  function removeLlm(id: string) {
    const c = cfg.value;
    if (!c || busy.value || c.llms.length <= 1) return;
    c.llms = c.llms.filter((l) => l.id !== id);
    for (const phone of c.phones) if (phone.llmId === id) phone.llmId = c.llms[0].id;
  }

  return { cfg, busy, error, dirty, adopt, discard, run, save, addPhone, removePhone, addLlm, removeLlm };
}

type AppState = ReturnType<typeof createProvidedState>;
const key: InjectionKey<AppState> = Symbol('Timbre app state');

function createProvidedState() {
  const editor = createEditor();
  const status = ref<PhoneStatus[]>([]);
  const selectedId = ref('');
  const selectedPhone = computed(() => editor.cfg.value?.phones.find((p) => p.id === selectedId.value) ?? editor.cfg.value?.phones[0]);
  const selectedStatus = computed(() => status.value.find((s) => s.id === selectedPhone.value?.id));
  return reactive({ ...editor, status, selectedId, selectedPhone, selectedStatus });
}

export function provideAppState() {
  const state = createProvidedState();
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  async function poll() {
    if (polling || disposed) return;
    polling = true;
    try {
      const next = await api.status();
      if (!disposed) state.status = next.phones;
    } catch { /* A temporary status failure must not replace unsaved edits. */ }
    finally { polling = false; }
  }
  onMounted(async () => {
    await state.run(async () => {
      const next = await api.config();
      if (!disposed) state.adopt(next);
    });
    if (disposed) return;
    void poll();
    timer = setInterval(poll, 2000);
  });
  onUnmounted(() => { disposed = true; clearInterval(timer); });
  provide(key, state);
  return state;
}

export function useAppState() {
  const state = inject(key);
  if (!state) throw new Error('Timbre app state is unavailable');
  return state;
}
