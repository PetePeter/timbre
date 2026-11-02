<script setup lang="ts">
import ToggleSwitch from 'primevue/toggleswitch';
import InputText from 'primevue/inputtext';
import BackupControls from '../components/BackupControls.vue';
import AppInputNumber from '../components/AppInputNumber.vue';
import FormField from '../components/FormField.vue';
import ServerFilePicker from '../components/ServerFilePicker.vue';
import { TELEFONY_PHAP_SCHEMA_PAGE, TELEFONY_RELEASES_PAGE } from '../../src/phone/phone-config.js';
import { useAppState } from '../app-state';
const state = useAppState();
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
  <BackupControls v-if="state.cfg" :disabled="state.busy" @restored="state.adopt" />
</template>
