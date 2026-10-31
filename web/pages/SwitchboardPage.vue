<script setup lang="ts">
import ActivityLanes from '../components/ActivityLanes.vue';
import TodayStrip from '../components/TodayStrip.vue';
import LiveCallPanel from '../components/LiveCallPanel.vue';
import QuickControls from '../components/QuickControls.vue';
import OutboundCallForm from '../components/OutboundCallForm.vue';
import { useSwitchboardActivity } from '../use-switchboard-activity';

const { lanes, loading, loadError, today } = useSwitchboardActivity();
</script>
<template>
  <div class="page-heading board-heading"><h1>Switchboard</h1></div>
  <div class="switchboard-layout"><section class="stack"><ActivityLanes :lanes="lanes" :loading="loading" :error="loadError" /><TodayStrip :counts="today" :loading="loading" /></section><aside class="stack"><LiveCallPanel /><QuickControls /><OutboundCallForm /></aside></div>
</template>
