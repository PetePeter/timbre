<script setup lang="ts">
import Button from 'primevue/button';
import PhonePanel from '../PhonePanel.vue';
import { useAppState } from '../app-state';
const state = useAppState();
</script>
<template>
  <div class="page-heading"><div><h1>Phones</h1><p>The mobiles connected to Timbre, each with its own line.</p></div><Button label="+ Add phone" :disabled="!state.cfg || state.busy" @click="state.addPhone" /></div>
  <PhonePanel v-if="state.cfg && state.selectedPhone" :key="state.selectedPhone.id" :phone="state.selectedPhone" :llms="state.cfg.llms" :status="state.selectedStatus" :can-remove="state.cfg.phones.length > 1" :busy="state.busy" :dirty="state.dirty" @remove="state.removePhone(state.selectedPhone!.id)" @run="state.run" />
</template>
