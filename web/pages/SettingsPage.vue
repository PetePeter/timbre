<script setup lang="ts">
import ToggleSwitch from 'primevue/toggleswitch';
import BackupControls from '../components/BackupControls.vue';
import AppTokensSection from '../components/AppTokensSection.vue';
import AppInputNumber from '../components/AppInputNumber.vue';
import FormField from '../components/FormField.vue';
import { useAppState } from '../app-state';
const state = useAppState();
</script>
<template>
  <div class="page-heading"><div><h1>Settings</h1><p>Make Timbre at home on your network.</p></div></div>
  <section v-if="state.cfg" class="panel stack settings-panel" :aria-busy="state.busy">
    <h2>Web access</h2>
    <p class="muted">This computer can always open Timbre at localhost. Allow LAN access to use it from another computer or phone on your network.</p>
    <FormField v-slot="{ inputAttrs }" :value="state.cfg.web.lan" hint="The server stores this setting as on or off.">
      <label class="control-row" for="lan-access"><span>Allow LAN access<small>Other devices need your access link once.</small></span><ToggleSwitch v-model="state.cfg.web.lan" :pt="{ input: inputAttrs }" input-id="lan-access" :disabled="state.busy" /></label>
    </FormField>
    <label class="field"><span>Port</span><FormField v-slot="{ inputAttrs }" :value="state.cfg.web.port" hint="Port must be from 1 to 65535."><AppInputNumber v-model="state.cfg.web.port" v-bind="inputAttrs" aria-label="Web port" :use-grouping="false" :allow-empty="false" :min="1" :max="65535" :step="1" :disabled="state.busy" /></FormField></label>
    <p v-if="state.cfg.web.lan && state.cfg.web.token" class="access-link">Access link: http://&lt;this-pc-ip&gt;:{{ state.cfg.web.port }}/?token={{ state.cfg.web.token }}</p>
    <p class="muted">Port and LAN changes apply when Timbre restarts.</p>
  </section>
  <AppTokensSection v-if="state.cfg" :phones="state.cfg.phones" :disabled="state.busy" />
  <BackupControls v-if="state.cfg" :disabled="state.busy" @restored="state.adopt" />
</template>
