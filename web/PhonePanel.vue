<script setup lang="ts">
/** One phone: live status, actions, and its main settings. */
import { computed, ref } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Textarea from 'primevue/textarea';
import ToggleSwitch from 'primevue/toggleswitch';
import { api, type LlmConfig, type PhoneEntry, type PhoneStatus } from './api';
import AppSelect from './components/AppSelect.vue';
import McpServersEditor from './components/McpServersEditor.vue';

const props = defineProps<{ phone: PhoneEntry; llms: LlmConfig[]; status?: PhoneStatus; canRemove: boolean; busy: boolean; dirty: boolean }>();
const emit = defineEmits<{ remove: []; run: [fn: () => Promise<unknown>] }>();

const open = ref(false);
const terminal = ref('');
const note = ref('');
const line = computed(() => props.phone.line);
const usesApiLlm = computed(() => props.llms.find((llm) => llm.id === props.phone.llmId)?.kind === 'api');
const connection = computed(() => {
  const current = props.status?.line;
  if (current?.process.state === 'failed' && /dongle not found/i.test(current.process.lastError)) return { text: 'No dongle', tone: 'rose' };
  if (current?.process.state === 'running' && current.line?.connected && current.line.link === 'up') return { text: 'Online', tone: 'green' };
  return { text: 'Offline', tone: 'sample-label' };
});

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

const blocklistText = computed({
  get: () => line.value.blocklist.join('\n'),
  set: (v: string) => { line.value.blocklist = v.split('\n').map((s) => s.trim()).filter(Boolean); },
});
</script>

<template>
  <fieldset class="panel stack" :disabled="busy">
    <legend class="visually-hidden">{{ phone.name }} phone settings</legend>
    <div class="row">
      <span class="dot" :class="health.cls" />
      <h2 class="grow">{{ phone.name }}</h2>
      <span class="pill" :class="connection.tone">{{ connection.text }}</span>
      <label class="check" :for="`enabled-${phone.id}`"><ToggleSwitch v-model="line.enabled" :input-id="`enabled-${phone.id}`" :disabled="busy" /> On</label>
    </div>
    <p class="muted">{{ health.text }} · answered by {{ status?.llm || '—' }}</p>
    <div class="row">
      <Button severity="secondary" :disabled="busy || dirty" title="Save first" @click="testSms">Test SMS</Button>
      <Button severity="secondary" :disabled="busy || dirty || !line.enabled" @click="restart">Restart telefony</Button>
      <Button v-if="status?.agentKind === 'cli'" severity="secondary" :disabled="busy" @click="showTerminal">Terminal</Button>
      <span class="grow" />
      <Button severity="secondary" :aria-expanded="open" @click="open = !open">{{ open ? 'Hide settings' : 'Settings' }}</Button>
    </div>
    <p v-if="note" class="muted">{{ note }}</p>
    <pre v-if="terminal" class="term">{{ terminal }}</pre>

    <div v-if="open" class="stack">
      <div class="grid2">
        <label class="field"><span>Name</span><InputText v-model="phone.name" /></label>
        <label class="field"><span>Answered by</span>
          <AppSelect v-model="phone.llmId" :options="llms" option-label="name" option-value="id" :disabled="busy" aria-label="Answered by" />
        </label>
        <label class="field"><span>Assistant name (spoken)</span><InputText v-model="line.persona.name" /></label>
        <label class="field"><span>Country code</span><InputText v-model="line.countryCode" placeholder="+61" /></label>
      </div>

      <McpServersEditor v-if="usesApiLlm" :servers="phone.mcpServers" :busy="busy" />

      <h3>telefony-app</h3>
      <div class="grid2">
        <label class="field"><span>Executable</span><InputText v-model="line.executable" placeholder="…/telefony-app.exe" /></label>
        <label class="field"><span>Bluetooth transport</span><InputText v-model="line.transport" placeholder="usb:0" /></label>
        <label class="field"><span>PhAP port</span><InputNumber v-model="line.port" :use-grouping="false" :allow-empty="false" :min="1" :max="65535" :disabled="busy" aria-label="PhAP port" /></label>
        <label class="field"><span>Voice</span>
          <AppSelect v-model="line.voice.tts" :options="[{ label: 'Auto', value: 'auto' }, { label: 'Piper', value: 'piper' }, { label: 'Windows SAPI', value: 'sapi' }, { label: 'None', value: 'none' }]" option-label="label" option-value="value" :disabled="busy" aria-label="Voice" />
        </label>
      </div>

      <h3>Greetings</h3>
      <label class="field"><span>Known callers</span><InputText v-model="line.persona.greetInText" /></label>
      <label class="field"><span>Unknown callers</span><Textarea v-model="line.persona.greetStranger" rows="2" /></label>

      <h3>Recording and retention</h3>
      <label class="check"><ToggleSwitch v-model="line.recordingNotice.enabled" :disabled="busy" /> Speak a recording notice when a call is answered</label>
      <label class="field"><span>Recording notice</span><InputText v-model="line.recordingNotice.text" :disabled="busy || !line.recordingNotice.enabled" /></label>
      <div class="grid2">
        <label class="field"><span>Recording retention (days)</span><InputNumber v-model="line.recordings.retentionDays" :allow-empty="false" :min="0" :disabled="busy" aria-label="Recording retention days" /></label>
        <label class="field"><span>Transcript retention (days)</span><InputNumber v-model="line.transcripts.retentionDays" :allow-empty="false" :min="0" :disabled="busy" aria-label="Transcript retention days" /></label>
      </div>
      <p class="muted">Set a retention value to 0 to keep that data indefinitely.</p>

      <label class="field"><span>Block list (one regex per line)</span><Textarea v-model="blocklistText" rows="3" /></label>

      <h3>Limits</h3>
      <div class="grid2">
        <label class="field"><span>Calls / hour</span><InputNumber v-model="line.limits.callsPerHour" :allow-empty="false" :min="0" :disabled="busy" aria-label="Calls per hour" /></label>
        <label class="field"><span>SMS / hour</span><InputNumber v-model="line.limits.smsPerHour" :allow-empty="false" :min="0" :disabled="busy" aria-label="SMS per hour" /></label>
        <label class="field"><span>Max call minutes</span><InputNumber v-model="line.limits.maxCallMin" :allow-empty="false" :min="1" :disabled="busy" aria-label="Maximum call minutes" /></label>
      </div>

      <Button v-if="canRemove" severity="danger" outlined :disabled="busy" @click="$emit('remove')">Remove phone</Button>
    </div>
  </fieldset>
</template>

<style scoped>
.narrow { flex: 0 0 110px; }
</style>
