<script setup lang="ts">
/** One phone: live status, actions, and its main settings. */
import { computed, ref } from 'vue';
import { api, type LlmConfig, type PhoneEntry, type PhoneStatus } from './api';

const props = defineProps<{ phone: PhoneEntry; llms: LlmConfig[]; status?: PhoneStatus; canRemove: boolean; busy: boolean; dirty: boolean }>();
const emit = defineEmits<{ remove: []; run: [fn: () => Promise<unknown>] }>();

const open = ref(false);
const terminal = ref('');
const note = ref('');
const line = computed(() => props.phone.line);

const health = computed(() => {
  const s = props.status;
  if (!s || !s.line.enabled) return { cls: '', text: 'Off' };
  if (s.agentProblem) return { cls: 'warn', text: s.agentProblem };
  const proc = s.line.process;
  if (proc.state === 'failed') return { cls: 'bad', text: `telefony failed: ${proc.lastError}` };
  if (proc.state === 'backoff') return { cls: 'warn', text: `telefony restarting: ${proc.lastError}` };
  if (proc.state !== 'running') return { cls: 'warn', text: 'telefony not running' };
  const l = s.line.line;
  if (!l?.connected) return { cls: 'warn', text: 'Connecting to telefony…' };
  if (l.link !== 'up') return { cls: 'warn', text: 'Phone not linked over Bluetooth' };
  if (l.call) return { cls: 'ok', text: `On a call: ${l.call.label} (${l.call.state})` };
  return { cls: 'ok', text: 'Ready' };
});

const testSms = () => emit('run', async () => {
  const r = await api.testSms(props.phone.id);
  note.value = r.sent ? 'Test SMS sent to the owner.' : `Not sent: ${r.reason ?? 'unknown'}`;
});
const restart = () => emit('run', () => api.restart(props.phone.id));
const showTerminal = () => emit('run', async () => { terminal.value = (await api.terminal(props.phone.id)).text || '(no output)'; });

function addContact() {
  line.value.contacts.push({ label: '', pattern: '', role: 'trusted', callIn: true, callOut: true, smsIn: true, smsOut: true, conf: false, pin: '', messages: false });
}

const blocklistText = computed({
  get: () => line.value.blocklist.join('\n'),
  set: (v: string) => { line.value.blocklist = v.split('\n').map((s) => s.trim()).filter(Boolean); },
});
</script>

<template>
  <section class="panel stack">
    <div class="row">
      <span class="dot" :class="health.cls" />
      <h2 class="grow">{{ phone.name }}</h2>
      <label class="check"><input v-model="line.enabled" type="checkbox" /> On</label>
    </div>
    <p class="muted">{{ health.text }} · answered by {{ status?.llm || '—' }}</p>
    <div class="row">
      <button :disabled="busy || dirty" title="Save first" @click="testSms">Test SMS</button>
      <button :disabled="busy || dirty || !line.enabled" @click="restart">Restart telefony</button>
      <button v-if="status?.agentKind === 'cli'" :disabled="busy" @click="showTerminal">Terminal</button>
      <span class="grow" />
      <button @click="open = !open">{{ open ? 'Hide settings' : 'Settings' }}</button>
    </div>
    <p v-if="note" class="muted">{{ note }}</p>
    <pre v-if="terminal" class="term">{{ terminal }}</pre>

    <div v-if="open" class="stack">
      <div class="grid2">
        <label class="field"><span>Name</span><input v-model="phone.name" /></label>
        <label class="field"><span>Answered by</span>
          <select v-model="phone.llmId"><option v-for="l in llms" :key="l.id" :value="l.id">{{ l.name }}</option></select>
        </label>
        <label class="field"><span>Assistant name (spoken)</span><input v-model="line.persona.name" /></label>
        <label class="field"><span>Country code</span><input v-model="line.countryCode" placeholder="+61" /></label>
      </div>

      <h3>telefony-app</h3>
      <div class="grid2">
        <label class="field"><span>Executable</span><input v-model="line.executable" placeholder="…/telefony-app.exe" /></label>
        <label class="field"><span>Bluetooth transport</span><input v-model="line.transport" placeholder="usb:0" /></label>
        <label class="field"><span>PhAP port</span><input v-model.number="line.port" type="number" /></label>
        <label class="field"><span>Voice</span>
          <select v-model="line.voice.tts"><option value="auto">Auto</option><option value="piper">Piper</option><option value="sapi">Windows SAPI</option><option value="none">None</option></select>
        </label>
      </div>

      <h3>Greetings</h3>
      <label class="field"><span>Known callers</span><input v-model="line.persona.greetInText" /></label>
      <label class="field"><span>Unknown callers</span><textarea v-model="line.persona.greetStranger" rows="2" /></label>

      <h3>Contacts</h3>
      <div v-for="(c, i) in line.contacts" :key="i" class="row contact">
        <input v-model="c.label" placeholder="Name" class="grow" />
        <input v-model="c.pattern" placeholder="+614… or 04…*" class="grow" />
        <select v-model="c.role" class="narrow"><option value="owner">Owner</option><option value="trusted">Trusted</option></select>
        <input v-model="c.pin" placeholder="PIN (6+)" inputmode="numeric" class="narrow" />
        <button class="danger" @click="line.contacts.splice(i, 1)">✕</button>
      </div>
      <button @click="addContact">+ Contact</button>

      <label class="field"><span>Block list (one regex per line)</span><textarea v-model="blocklistText" rows="3" /></label>

      <h3>Limits</h3>
      <div class="grid2">
        <label class="field"><span>Calls / hour</span><input v-model.number="line.limits.callsPerHour" type="number" min="0" /></label>
        <label class="field"><span>SMS / hour</span><input v-model.number="line.limits.smsPerHour" type="number" min="0" /></label>
        <label class="field"><span>Max call minutes</span><input v-model.number="line.limits.maxCallMin" type="number" min="1" /></label>
      </div>

      <button v-if="canRemove" class="danger" :disabled="busy" @click="$emit('remove')">Remove phone</button>
    </div>
  </section>
</template>

<style scoped>
.contact input, .contact select { width: auto; min-width: 0; }
.narrow { flex: 0 0 110px; }
</style>
