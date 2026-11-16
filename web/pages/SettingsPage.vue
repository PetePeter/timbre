<script setup lang="ts">
import { ref, watch } from 'vue';
import ToggleSwitch from 'primevue/toggleswitch';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import BackupControls from '../components/BackupControls.vue';
import AppInputNumber from '../components/AppInputNumber.vue';
import FormField from '../components/FormField.vue';
import ServerFilePicker from '../components/ServerFilePicker.vue';
import { TELEFONY_PHAP_SCHEMA_PAGE, TELEFONY_RELEASES_PAGE } from '../../src/phone/phone-config.js';
import { MCP_SECRET_MASK } from '../../src/config/mcp-secret-mask';
import { useAppState } from '../app-state';
const state = useAppState();
const mqttPasswordDraft = ref('');

watch(() => state.cfg?.mqtt.password, (password, previous) => {
  if (password === MCP_SECRET_MASK && previous && previous !== MCP_SECRET_MASK) mqttPasswordDraft.value = '';
  else if (password !== MCP_SECRET_MASK) mqttPasswordDraft.value = password ?? '';
}, { immediate: true });

function updateMqttPassword(value: string) {
  const mqtt = state.cfg?.mqtt;
  if (!mqtt) return;
  mqttPasswordDraft.value = value;
  mqtt.password = value || (mqtt.password === MCP_SECRET_MASK ? MCP_SECRET_MASK : '');
}

function clearMqttPassword() {
  mqttPasswordDraft.value = '';
  if (state.cfg) state.cfg.mqtt.password = '';
}

function updateMqttField(field: 'url' | 'username' | 'topicPrefix', value: string) {
  if (state.cfg) state.cfg.mqtt[field] = value;
}
</script>
<template>
  <div class="page-heading"><div><h1>Settings</h1><p>Make Timbre at home on your network.</p></div></div>
  <section v-if="state.cfg" class="panel stack settings-panel" :aria-busy="state.busy">
    <h2>PhAP server</h2>
    <p class="muted">Every phone runs its own process and data folder using this shared executable.</p>
    <div class="field">
      <span><label for="telefony-executable">PhAP server executable</label></span>
      <div class="row">
        <FormField v-slot="{ inputAttrs }" :value="state.cfg.telefony.executable" class="grow" hint="Choose an existing PhAP-compatible server executable."><InputText id="telefony-executable" v-model="state.cfg.telefony.executable" v-bind="inputAttrs" class="grow" placeholder="Path to a PhAP server executable" :disabled="state.busy" /></FormField>
        <ServerFilePicker @select="state.cfg.telefony.executable = $event" />
      </div>
      <p class="muted small telefony-links"><a :href="TELEFONY_RELEASES_PAGE" target="_blank" rel="noopener">Download telefony-app</a><span>·</span><a :href="TELEFONY_PHAP_SCHEMA_PAGE" target="_blank" rel="noopener">PhAP protocol schema</a></p>
    </div>
  </section>
  <section v-if="state.cfg" class="panel stack settings-panel" :aria-busy="state.busy">
    <h2>Web access</h2>
    <p class="muted">This computer can always open Timbre at localhost. Allow LAN access to use it from another computer or phone on your network.</p>
    <FormField v-slot="{ inputAttrs }" :value="state.cfg.web.lan" hint="The server stores this setting as on or off.">
      <label class="control-row" for="lan-access"><span>Allow LAN access<small>Other devices need your access link once.</small></span><ToggleSwitch v-model="state.cfg.web.lan" :pt="{ input: inputAttrs }" input-id="lan-access" :disabled="state.busy" /></label>
    </FormField>
    <label class="field field-narrow"><span>Port</span><FormField v-slot="{ inputAttrs }" :value="state.cfg.web.port" hint="Port must be from 1 to 65535."><AppInputNumber v-model="state.cfg.web.port" v-bind="inputAttrs" aria-label="Web port" :use-grouping="false" :allow-empty="false" :min="1" :max="65535" :step="1" :disabled="state.busy" /></FormField></label>
    <p v-if="state.cfg.web.lan && state.cfg.web.token" class="access-link">Access link: http://&lt;this-pc-ip&gt;:{{ state.cfg.web.port }}/?token={{ state.cfg.web.token }}</p>
    <p class="muted">Port and LAN changes apply when Timbre restarts.</p>
  </section>
  <section v-if="state.cfg" class="panel stack settings-panel" :aria-busy="state.busy">
    <h2>MQTT notifications</h2>
    <p class="muted">Publish allowlisted call and SMS events to your MQTT broker. Timbre only publishes notifications; MQTT cannot control calls or settings.</p>
    <FormField v-slot="{ inputAttrs }" :value="state.cfg.mqtt.enabled" hint="The publisher reconnects automatically while enabled.">
      <label class="control-row" for="mqtt-enabled"><span>Enable MQTT<small>Send call and SMS notifications to your broker.</small></span><ToggleSwitch v-model="state.cfg.mqtt.enabled" :pt="{ input: inputAttrs }" input-id="mqtt-enabled" :disabled="state.busy" /></label>
    </FormField>
    <div class="grid2">
      <div class="field"><span><label for="mqtt-url">Broker URL</label></span><InputText id="mqtt-url" :model-value="state.cfg?.mqtt.url ?? ''" placeholder="mqtt://homeassistant.local:1883" :disabled="state.busy" aria-describedby="mqtt-url-hint" @update:model-value="updateMqttField('url', String($event ?? ''))" /><small id="mqtt-url-hint" class="muted small">For example, mqtt://homeassistant.local:1883.</small></div>
      <div class="field"><span><label for="mqtt-username">Username (optional)</label></span><InputText id="mqtt-username" :model-value="state.cfg?.mqtt.username ?? ''" autocomplete="username" :disabled="state.busy" aria-describedby="mqtt-username-hint" @update:model-value="updateMqttField('username', String($event ?? ''))" /><small id="mqtt-username-hint" class="muted small">Leave empty if the broker does not require a username.</small></div>
      <div class="field"><span><label for="mqtt-password">Password (optional)</label></span><div class="row"><InputText id="mqtt-password" class="grow" :model-value="mqttPasswordDraft" type="password" autocomplete="new-password" :placeholder="state.cfg?.mqtt.password === MCP_SECRET_MASK ? 'Saved · enter to replace' : 'Password'" :disabled="state.busy" aria-describedby="mqtt-password-hint" @update:model-value="updateMqttPassword(String($event ?? ''))" /><Button v-if="state.cfg?.mqtt.password" label="Clear" severity="secondary" text aria-label="Clear MQTT password" :disabled="state.busy" @click="clearMqttPassword" /></div><small id="mqtt-password-hint" class="muted small">Leave blank to keep a saved password; enter a new value to replace it.</small></div>
      <div class="field"><span><label for="mqtt-topic-prefix">Topic prefix</label></span><InputText id="mqtt-topic-prefix" :model-value="state.cfg?.mqtt.topicPrefix ?? ''" placeholder="timbre" :disabled="state.busy" aria-describedby="mqtt-topic-prefix-hint" @update:model-value="updateMqttField('topicPrefix', String($event ?? ''))" /><small id="mqtt-topic-prefix-hint" class="muted small">Topics use this prefix followed by phone, event kind, and event name.</small></div>
    </div>
  </section>
  <BackupControls v-if="state.cfg" :disabled="state.busy" @restored="state.adopt" />
</template>
