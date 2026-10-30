<script setup lang="ts">
/** One phone: live status, actions, and its main settings. */
import { computed, ref } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import ToggleSwitch from 'primevue/toggleswitch';
import { api, type LlmConfig, type PhoneEntry, type PhoneStatus } from './api';
import AppInputNumber from './components/AppInputNumber.vue';
import AppSelect from './components/AppSelect.vue';
import McpServersEditor from './components/McpServersEditor.vue';
import FormField from './components/FormField.vue';
import { blocklistPatternError, retentionDaysError } from './field-validation';

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
      <FormField v-slot="{ inputAttrs }" :value="line.enabled" hint="The server stores this setting as on or off.">
        <label class="check" :for="`enabled-${phone.id}`"><ToggleSwitch v-model="line.enabled" :pt="{ input: inputAttrs }" :input-id="`enabled-${phone.id}`" :disabled="busy" /> On</label>
      </FormField>
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
        <label class="field"><span>Name</span><FormField v-slot="{ inputAttrs }" :value="phone.name" hint="No fixed length or format limit is enforced."><InputText v-model="phone.name" v-bind="inputAttrs" /></FormField></label>
        <label class="field"><span>Answered by</span>
          <FormField v-slot="{ inputAttrs }" :value="phone.llmId" hint="Choose one of the configured models."><AppSelect v-model="phone.llmId" v-bind="inputAttrs" :options="llms" option-label="name" option-value="id" :disabled="busy" aria-label="Answered by" /></FormField>
        </label>
        <label class="field"><span>Assistant name (spoken)</span><FormField v-slot="{ inputAttrs }" :value="line.persona.name" hint="No fixed length limit is enforced."><InputText v-model="line.persona.name" v-bind="inputAttrs" /></FormField></label>
        <label class="field"><span>Country code</span><FormField v-slot="{ inputAttrs }" :value="line.countryCode" hint="Enter the international calling prefix used to interpret local numbers, such as +61."><InputText v-model="line.countryCode" v-bind="inputAttrs" placeholder="+61" /></FormField></label>
      </div>

      <McpServersEditor v-if="usesApiLlm" :servers="phone.mcpServers" :busy="busy" />

      <h3>telefony-app</h3>
      <div class="grid2">
        <label class="field"><span>Executable</span><FormField v-slot="{ inputAttrs }" :value="line.executable" hint="Optional; enter the telefony-app program path."><InputText v-model="line.executable" v-bind="inputAttrs" placeholder="…/telefony-app.exe" /></FormField></label>
        <label class="field"><span>Bluetooth transport</span><FormField v-slot="{ inputAttrs }" :value="line.transport" hint="Enter the transport identifier reported by the phone setup tool."><InputText v-model="line.transport" v-bind="inputAttrs" placeholder="usb:0" /></FormField></label>
        <label class="field"><span>PhAP port</span><FormField v-slot="{ inputAttrs }" :value="line.port" hint="Port must be from 1 to 65535."><AppInputNumber v-model="line.port" v-bind="inputAttrs" :use-grouping="false" :allow-empty="false" :min="1" :max="65535" :step="1" :disabled="busy" aria-label="PhAP port" /></FormField></label>
        <label class="field"><span>Voice</span>
          <FormField v-slot="{ inputAttrs }" :value="line.voice.tts" hint="Choose one of the listed voice modes."><AppSelect v-model="line.voice.tts" v-bind="inputAttrs" :options="[{ label: 'Auto', value: 'auto' }, { label: 'Piper', value: 'piper' }, { label: 'Windows SAPI', value: 'sapi' }, { label: 'None', value: 'none' }]" option-label="label" option-value="value" :disabled="busy" aria-label="Voice" /></FormField>
        </label>
      </div>

      <h3>Greetings</h3>
      <label class="field"><span>Known callers</span><FormField v-slot="{ inputAttrs }" :value="line.persona.greetInText" hint="No fixed length limit is enforced."><InputText v-model="line.persona.greetInText" v-bind="inputAttrs" /></FormField></label>
      <label class="field"><span>Unknown callers</span><FormField v-slot="{ inputAttrs }" :value="line.persona.greetStranger" hint="No fixed length limit is enforced."><Textarea v-model="line.persona.greetStranger" v-bind="inputAttrs" rows="2" /></FormField></label>

      <h3>Recording and retention</h3>
      <FormField v-slot="{ inputAttrs }" :value="line.recordingNotice.enabled" hint="The server stores this setting as on or off.">
        <label class="check"><ToggleSwitch v-model="line.recordingNotice.enabled" :pt="{ input: inputAttrs }" :disabled="busy" /> Speak a recording notice when a call is answered</label>
      </FormField>
      <label class="field"><span>Recording notice</span><FormField v-slot="{ inputAttrs }" :value="line.recordingNotice.text" hint="No fixed length limit is enforced."><InputText v-model="line.recordingNotice.text" v-bind="inputAttrs" :disabled="busy || !line.recordingNotice.enabled" /></FormField></label>
      <div class="grid2">
        <label class="field"><span>Recording retention (days)</span><FormField v-slot="{ inputAttrs }" :value="line.recordings.retentionDays" hint="Enter a finite number of 0 or more days; invalid values use the default." :validate="retentionDaysError"><AppInputNumber v-model="line.recordings.retentionDays" v-bind="inputAttrs" :allow-empty="false" :min="0" :disabled="busy" aria-label="Recording retention days" /></FormField></label>
        <label class="field"><span>Transcript retention (days)</span><FormField v-slot="{ inputAttrs }" :value="line.transcripts.retentionDays" hint="Enter a finite number of 0 or more days; invalid values use the default." :validate="retentionDaysError"><AppInputNumber v-model="line.transcripts.retentionDays" v-bind="inputAttrs" :allow-empty="false" :min="0" :disabled="busy" aria-label="Transcript retention days" /></FormField></label>
      </div>
      <p class="muted">Set a retention value to 0 to keep that data indefinitely.</p>

      <label class="field"><span>Block list (one regex per line)</span><FormField v-slot="{ inputAttrs }" :value="blocklistText" hint="Use one valid JavaScript regular expression per line; blank lines are ignored." :validate="blocklistPatternError"><Textarea v-model="blocklistText" v-bind="inputAttrs" rows="3" /></FormField></label>

      <h3>Limits</h3>
      <div class="grid2">
        <label class="field"><span>Calls / hour</span><FormField v-slot="{ inputAttrs }" :value="line.limits.callsPerHour" hint="No upper cap is set; calls are blocked once the rolling-hour count reaches this value."><AppInputNumber v-model="line.limits.callsPerHour" v-bind="inputAttrs" :allow-empty="false" :min="0" :disabled="busy" aria-label="Calls per hour" /></FormField></label>
        <label class="field"><span>SMS / hour</span><FormField v-slot="{ inputAttrs }" :value="line.limits.smsPerHour" hint="No upper cap is set; SMS are blocked once the rolling-hour count reaches this value."><AppInputNumber v-model="line.limits.smsPerHour" v-bind="inputAttrs" :allow-empty="false" :min="0" :disabled="busy" aria-label="SMS per hour" /></FormField></label>
        <label class="field"><span>Max call minutes</span><FormField v-slot="{ inputAttrs }" :value="line.limits.maxCallMin" hint="Positive values end calls after that many minutes; 0 disables the timeout. No upper cap is configured."><AppInputNumber v-model="line.limits.maxCallMin" v-bind="inputAttrs" :allow-empty="false" :min="0" :disabled="busy" aria-label="Maximum call minutes" /></FormField></label>
      </div>

      <Button v-if="canRemove" severity="danger" outlined :disabled="busy" @click="$emit('remove')">Remove phone</Button>
    </div>
  </fieldset>
</template>

<style scoped>
.narrow { flex: 0 0 110px; }
</style>
