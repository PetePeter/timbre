<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type AddressBookContact, type AppTokenMetadata } from '../api';
import GuideStep from '../components/GuideStep.vue';
import { useAppState } from '../app-state';
import { isClockTime, isTimeZone } from '../../src/phone/schedule.js';

const state = useAppState();
const contacts = ref<AddressBookContact[]>([]);
const contactsLoaded = ref(false);
const contactsUnavailable = ref(false);
const appTokens = ref<AppTokenMetadata[]>([]);
const tokensLoaded = ref(false);
const tokensUnavailable = ref(false);
let contactsRequest = 0;

watch(() => state.selectedPhone?.id, async (phoneId) => {
  const request = ++contactsRequest;
  contacts.value = [];
  contactsLoaded.value = false;
  contactsUnavailable.value = false;
  if (!phoneId) return;
  try {
    const next = await api.contacts(phoneId);
    if (request === contactsRequest) {
      contacts.value = next;
      contactsLoaded.value = true;
    }
  } catch {
    if (request === contactsRequest) contactsUnavailable.value = true;
  }
}, { immediate: true });

onMounted(async () => {
  try {
    appTokens.value = (await api.appTokens()).items;
    tokensLoaded.value = true;
  } catch {
    tokensUnavailable.value = true;
  }
});

const steps = computed(() => {
  const phone = state.selectedPhone;
  const line = phone?.line;
  const runtime = state.selectedStatus?.line;
  const llm = state.cfg?.llms.find((item) => item.id === phone?.llmId);
  const agentReady = llm?.kind === 'api'
    ? Boolean(llm.baseUrl.trim() && llm.model.trim())
    : Boolean(llm?.kind === 'cli' && llm.preset === 'claude-code' && llm.command.trim());
  const schedule = line?.schedule;
  const validSchedule = Boolean(schedule && isTimeZone(schedule.timeZone) && schedule.slots.some((slot) =>
    slot.days.length > 0 && isClockTime(slot.start) && isClockTime(slot.end) && slot.start !== slot.end));
  const policies = line ? [line.inboundHandling.default, ...line.inboundHandling.rules, ...line.schedule.slots] : [];
  const inboundRulesSet = Boolean(line && (
    line.screening.allow.length + line.screening.block.length + line.inboundHandling.rules.length > 0
  ));
  const autoReplySet = policies.some((policy) => policy.smsAutoReply.mode !== 'none');
  const summaryTextSet = Boolean(line?.transcripts.smsSummary && contacts.value.some((contact) =>
    contact.isUser && (contact.summaryNotifications?.length ?? 0) > 0));
  const spamSet = Boolean(line && Number.isFinite(line.spam.threshold) && line.spam.threshold >= 0
    && line.spam.threshold <= 100 && ['screen', 'block'].includes(line.spam.action));
  const retentionSet = Boolean(line && Number.isFinite(line.recordings.retentionDays) && line.recordings.retentionDays >= 0
    && Number.isFinite(line.transcripts.retentionDays) && line.transcripts.retentionDays >= 0);
  const voicemailSet = Boolean(line && line.transcripts.enabled && [
    line.inboundHandling.default,
    ...line.inboundHandling.rules,
    ...line.schedule.slots,
  ].some((policy) => policy.action === 'message'));
  const phoneConnected = Boolean(runtime?.line?.connected && runtime.line.link === 'up');
  const userWithPin = contacts.value.some((contact) => contact.isUser && contact.pinSet && !contact.pinNeedsReentry);
  const contactsSet = contactsLoaded.value && contacts.value.some((contact) => contact.numbers.length > 0) && userWithPin;
  const appTokenSet = tokensLoaded.value && appTokens.value.length > 0;
  const web = state.cfg?.web;

  return [
    { title: 'Phone + Bluetooth pairing', description: 'Add a phone, choose its USB dongle, then pair it in the setup wizard.', done: Boolean(state.cfg?.telefony.executable.trim() && /^usb:/i.test(line?.transport.trim() ?? '')), to: { path: '/phones', query: { setup: '1' } }, action: 'Open setup wizard' },
    { title: 'Choose the agent', description: 'Use an API model URL and model; add a key if your provider needs one, or choose the Claude Code preset.', done: agentReady, to: '/agent', action: 'Open Agent' },
    { title: 'Enable the line', description: 'Turn the phone line on after its dongle and agent are ready.', done: Boolean(line?.enabled), to: '/phones', action: 'Open Phones' },
    { title: 'Persona + voice', description: 'Set the name, style and voice callers will hear.', done: Boolean(line?.persona.name.trim() && line.voice.tts !== 'none'), to: '/agent', action: 'Set persona and voice' },
    { title: 'Contacts, users + PIN', description: 'Add people, mark yourself as a user, and set your caller PIN.', done: contactsSet, to: '/people', action: 'Open People' },
    { title: 'Inbound rules + schedule', description: 'Choose who may call and set at least one weekly time slot.', done: inboundRulesSet && validSchedule, to: '/access', action: 'Open Call access' },
    { title: 'SMS auto-reply + summary texts', description: 'Set an automatic reply and choose which call summaries your user contact receives.', done: autoReplySet && summaryTextSet, to: '/access', action: 'Set auto-reply', extraActions: [{ to: '/people', label: 'Set summary texts' }] },
    { title: 'Spam', description: 'Choose whether spam scoring screens or blocks likely spam calls.', done: spamSet, to: '/access', action: 'Set spam handling' },
    { title: 'Recording + transcript retention', description: 'Review how long recordings and transcripts are kept. Set 0 to keep them indefinitely.', done: retentionSet, to: '/phones', action: 'Review retention' },
    { title: 'Outbound “Call for me”', description: 'Let the call agent place calls on your behalf within your call permissions.', done: Boolean(line?.enabled && line.masters.callOut && agentReady), to: '/', action: 'Open Switchboard' },
    { title: 'Live listen / take over', description: 'When the phone is connected, you can listen to an active call or take it over.', done: phoneConnected, to: '/live', action: 'Open Live' },
    { title: 'Voicemail', description: 'Choose “Take a message” for callers and keep transcripts enabled.', done: voicemailSet, to: '/access', action: 'Set message handling' },
    { title: 'Browser test call', description: 'Try caller and agent messages in a virtual call. It does not dial a real phone.', done: Boolean(phoneConnected && agentReady), to: '/live', action: 'Open test call' },
    { title: 'LAN access token', description: 'Enable LAN access and use the access link from another device on your network.', done: Boolean(web?.lan && web.token.trim()), to: '/settings', action: 'Open web access' },
    { title: 'App tokens + REST, Swagger + MCP', description: 'Create a token for REST /v1. MCP uses a separate token for each phone.', done: appTokenSet, to: '/settings', action: 'Open app tokens', extraActions: [{ href: '/api/docs', label: 'Open Swagger docs' }] },
    { title: 'Backup + restore', description: 'Export a backup and learn how to restore it from Settings.', done: Boolean(state.cfg), to: '/settings', action: 'Open backup and restore' },
  ];
});
</script>

<template>
  <div class="page-heading"><div><h1>Guide</h1><p>Work through these steps for {{ state.selectedPhone?.name ?? 'your phone' }}.</p></div></div>
  <p class="guide-note muted">Statuses follow your settings and current connection. For test calls and backups, Done means ready to use; Timbre cannot see whether you tried them.</p>
  <p v-if="contactsUnavailable || tokensUnavailable" class="error-banner" role="alert">Some setup checks could not load. Refresh this page to try again.</p>
  <p v-if="!state.cfg" class="muted" role="status">Loading your settings…</p>
  <section v-else-if="!state.selectedPhone" class="panel empty-state guide-empty">
    <h2>No phones configured</h2>
    <p>Set up a phone to see your setup checklist.</p>
    <RouterLink :to="{ path: '/phones', query: { setup: '1' } }">Set up a phone</RouterLink>
  </section>
  <ol v-else class="guide-list" aria-label="Phone setup checklist">
    <GuideStep v-for="(step, index) in steps" :key="step.title" :number="index + 1" v-bind="step" />
  </ol>
  <section class="panel stack agent-guide" aria-labelledby="agent-guide-title">
    <div>
      <h2 id="agent-guide-title">How agents talk to Timbre</h2>
      <p class="muted">Choose a connection path in Agent settings, then assign it to a phone.</p>
    </div>
    <div class="agent-guide-grid">
      <article class="agent-guide-path">
        <h3>OpenAI-compatible API model</h3>
        <p>Timbre sends the phone tools as function definitions and runs their tool calls in the Timbre process.</p>
        <ol>
          <li>In <RouterLink to="/agent">Agent</RouterLink>, add or choose an API model and enter its base URL, model, and optional key.</li>
          <li>Assign that model to the phone and save the settings.</li>
        </ol>
      </article>
      <article class="agent-guide-path">
        <h3>Claude Code or another CLI</h3>
        <p>Timbre runs the CLI in a PTY and pastes caller events into it. The CLI calls phone tools back over MCP.</p>
        <ol>
          <li>In <RouterLink to="/agent">Agent</RouterLink>, choose the Claude Code preset or configure a CLI command.</li>
          <li>For a custom CLI, use <code>{mcpConfig}</code> or <code>{mcpUrl}</code> in its arguments. Timbre fills the placeholders and writes the phone-scoped MCP URL and token config at launch.</li>
          <li>Assign the CLI to the phone and save. Its phone tools are served at <code>/mcp/{phoneId}</code>.</li>
        </ol>
      </article>
      <article class="agent-guide-path">
        <h3>External MCP client</h3>
        <p>External clients use the app MCP endpoint with a scoped app token.</p>
        <ol>
          <li>Open <RouterLink to="/settings">Settings → Connected apps</RouterLink> and create a token for the phone and allowed actions.</li>
          <li>Set the client URL to <code>/mcp</code> and send <code>Authorization: Bearer &lt;app-token&gt;</code>, or use the setup snippet shown with the token.</li>
        </ol>
      </article>
    </div>
  </section>
</template>

<style scoped>
.guide-note { max-width: 850px; margin: -10px 0 20px; font-size: .92rem; }
.guide-list { display: grid; gap: 12px; max-width: 920px; margin: 0; padding: 0; list-style: none; }
.agent-guide-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 18px; }
.agent-guide-path { display: grid; align-content: start; gap: 8px; }
.agent-guide-path ol { margin: 0; padding-left: 20px; }
</style>
