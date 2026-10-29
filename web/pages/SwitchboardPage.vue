<script setup lang="ts">
import ActivityLanes from '../components/ActivityLanes.vue';
import TodayStrip from '../components/TodayStrip.vue';
import LiveCallPanel from '../components/LiveCallPanel.vue';
import QuickControls from '../components/QuickControls.vue';
</script>
<template>
  <div class="page-heading board-heading"><h1>Switchboard</h1><span class="pill sample-label">Sample activity</span></div>
  <div class="switchboard-layout"><section class="stack"><ActivityLanes /><TodayStrip /></section><aside class="stack"><LiveCallPanel /><QuickControls /></aside></div>
</template>
