<script setup lang="ts">
import InputNumber from 'primevue/inputnumber';
import ToggleSwitch from 'primevue/toggleswitch';
import { useAppState } from '../app-state';
const state = useAppState();
</script>
<template>
  <div class="page-heading"><div><h1>Settings</h1><p>Make Timbre at home on your network.</p></div></div>
  <section v-if="state.cfg" class="panel stack settings-panel" :aria-busy="state.busy">
    <h2>Web access</h2>
    <p class="muted">This computer can always open Timbre at localhost. Allow LAN access to use it from another computer or phone on your network.</p>
    <label class="control-row" for="lan-access"><span>Allow LAN access<small>Other devices need your access link once.</small></span><ToggleSwitch v-model="state.cfg.web.lan" input-id="lan-access" :disabled="state.busy" /></label>
    <label class="field"><span>Port</span><InputNumber v-model="state.cfg.web.port" aria-label="Web port" :use-grouping="false" :allow-empty="false" :min="1" :max="65535" :disabled="state.busy" /></label>
    <p v-if="state.cfg.web.lan && state.cfg.web.token" class="access-link">Access link: http://&lt;this-pc-ip&gt;:{{ state.cfg.web.port }}/?token={{ state.cfg.web.token }}</p>
    <p class="muted">Port and LAN changes apply when Timbre restarts.</p>
  </section>
</template>
