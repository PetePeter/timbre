<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import { api } from '../api';
import { useThemeOverlayProps } from '../theme-overlay';

type CallState = 'idle' | 'starting' | 'ringing' | 'active' | 'held' | 'ended';
type TestMessage = { speaker: 'caller' | 'agent'; text: string };

const props = defineProps<{ visible: boolean; phoneId: string | null; phoneName: string }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const overlayProps = useThemeOverlayProps();
const callerNumber = ref('');
const callerText = ref('');
const callState = ref<CallState>('idle');
const busy = ref(false);
const error = ref('');
const messages = ref<TestMessage[]>([]);
const downloadUrl = ref('');
let activePhoneId = '';
let activeCallId = '';
let eventSource: EventSource | null = null;
let disposed = false;

function closeStream(): void {
  eventSource?.close();
  eventSource = null;
}

function resetEndedCall(): void {
  if (callState.value !== 'ended') return;
  closeStream();
  activePhoneId = '';
  activeCallId = '';
  callState.value = 'idle';
  callerText.value = '';
  error.value = '';
  messages.value = [];
  if (downloadUrl.value) URL.revokeObjectURL(downloadUrl.value);
  downloadUrl.value = '';
}

watch(() => props.visible, (visible, wasVisible) => {
  if (visible && !wasVisible) resetEndedCall();
});

function updateDownload(): void {
  if (downloadUrl.value) URL.revokeObjectURL(downloadUrl.value);
  const transcript = messages.value.map(({ speaker, text }) => `${speaker === 'caller' ? callerNumber.value : 'Agent'}: ${text}`).join('\n\n');
  downloadUrl.value = URL.createObjectURL(new Blob([transcript], { type: 'text/plain;charset=utf-8' }));
}

function openStream(phoneId: string, callId: string): void {
  closeStream();
  eventSource = new EventSource(api.testCallEventsUrl(phoneId, callId));
  eventSource.addEventListener('state', (raw) => {
    const event = JSON.parse((raw as MessageEvent<string>).data) as { state: CallState };
    callState.value = event.state;
    if (event.state === 'ended') closeStream();
  });
  eventSource.addEventListener('message', (raw) => {
    const event = JSON.parse((raw as MessageEvent<string>).data) as TestMessage;
    messages.value.push({ speaker: event.speaker, text: event.text });
    updateDownload();
  });
  eventSource.onerror = () => {
    if (callState.value === 'ended') return;
    error.value = 'The test-call stream disconnected. The call is ending.';
    closeStream();
    void api.endTestCall(phoneId, callId).catch(() => undefined);
  };
}

async function startCall(): Promise<void> {
  const phoneId = props.phoneId;
  if (!phoneId || busy.value) return;
  busy.value = true;
  error.value = '';
  messages.value = [];
  updateDownload();
  callState.value = 'starting';
  try {
    const started = await api.startTestCall(phoneId, callerNumber.value.trim());
    activePhoneId = phoneId;
    activeCallId = started.callId;
    if (disposed) {
      await api.endTestCall(phoneId, started.callId).catch(() => undefined);
      activePhoneId = '';
      activeCallId = '';
      return;
    }
    openStream(phoneId, started.callId);
  } catch (err) {
    callState.value = 'idle';
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

async function sendUtterance(): Promise<void> {
  const text = callerText.value.trim();
  if (!text || !activePhoneId || !activeCallId || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.sendTestCallUtterance(activePhoneId, activeCallId, text);
    callerText.value = '';
  } catch (err) { error.value = (err as Error).message; }
  finally { busy.value = false; }
}

async function hangUp(): Promise<void> {
  if (!activePhoneId || !activeCallId || callState.value === 'ended') return;
  busy.value = true;
  try { await api.endTestCall(activePhoneId, activeCallId); }
  catch (err) { error.value = (err as Error).message; }
  finally { busy.value = false; }
}

async function setVisible(visible: boolean): Promise<void> {
  if (!visible) {
    if (busy.value && !activeCallId) return;
    await hangUp();
  }
  emit('update:visible', visible);
}

onBeforeUnmount(() => {
  disposed = true;
  closeStream();
  if (activePhoneId && activeCallId && callState.value !== 'ended') {
    void api.endTestCall(activePhoneId, activeCallId).catch(() => undefined);
  }
  if (downloadUrl.value) URL.revokeObjectURL(downloadUrl.value);
});
</script>

<template>
  <Dialog v-bind="overlayProps" :visible="visible" modal :draggable="false" class="test-call-dialog" header="Test call" @update:visible="setVisible">
    <p class="muted">Type as {{ callerNumber || 'the caller' }}. The configured phone agent handles the message.</p>
    <form v-if="callState === 'idle'" class="stack" @submit.prevent="startCall">
      <label class="field">
        <span>Caller number</span>
        <InputText v-model="callerNumber" type="tel" autocomplete="tel" placeholder="+614…" required minlength="3" maxlength="32" :disabled="busy" />
      </label>
      <Button type="submit" label="Start test call" :loading="busy" :disabled="!phoneId || callerNumber.trim().length < 3" />
    </form>
    <template v-else>
      <div class="test-call-status"><span class="pill" :class="callState === 'active' ? 'green' : 'sky'">{{ callState }}</span><span class="muted">{{ phoneName }}</span></div>
      <ol class="test-call-transcript" aria-label="Test call transcript" aria-live="polite">
        <li v-for="(message, index) in messages" :key="index" :class="message.speaker">
          <strong>{{ message.speaker === 'caller' ? 'Caller' : 'Agent' }}</strong>
          <span>{{ message.text }}</span>
        </li>
        <li v-if="!messages.length" class="muted">The call is connecting…</li>
      </ol>
      <form v-if="callState !== 'ended'" class="stack" @submit.prevent="sendUtterance">
        <label class="field">
          <span>Your message</span>
          <Textarea v-model="callerText" rows="3" auto-resize maxlength="4000" :disabled="busy || callState !== 'active'" />
        </label>
        <div class="row test-call-actions">
          <Button type="submit" label="Send" :disabled="busy || callState !== 'active' || !callerText.trim()" :loading="busy" />
          <Button label="Hang up" severity="secondary" outlined :disabled="busy" @click="hangUp" />
        </div>
      </form>
      <div v-else class="row test-call-actions">
        <a v-if="downloadUrl" :href="downloadUrl" download="test-call-transcript.txt">Download transcript</a>
        <Button label="Close" severity="secondary" @click="setVisible(false)" />
      </div>
    </template>
    <p v-if="error" class="test-call-error" role="alert">{{ error }}</p>
  </Dialog>
</template>

<style scoped>
.test-call-dialog { width: min(36rem, calc(100vw - 2rem)); }
.test-call-status, .test-call-actions { align-items: center; display: flex; gap: .75rem; }
.test-call-transcript { display: flex; flex-direction: column; gap: .65rem; list-style: none; margin: 1rem 0; max-height: 18rem; overflow: auto; padding: 0; }
.test-call-transcript li { background: var(--surface-card); border: 1px solid var(--surface-border); border-radius: .65rem; display: grid; gap: .2rem; padding: .65rem .8rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.test-call-transcript li.caller { align-self: flex-end; max-width: 90%; }
.test-call-transcript li.agent { align-self: flex-start; max-width: 90%; }
.test-call-error { color: var(--red-600); }
</style>
