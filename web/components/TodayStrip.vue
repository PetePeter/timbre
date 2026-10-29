<script setup lang="ts">
const levels = [12, 18, 10, 25, 15, 32, 42, 24, 18, 28, 52, 68, 44, 30, 48, 82, 60, 38, 25, 44, 58, 34, 24, 46, 70, 48, 30, 20, 36, 52, 28, 16, 24, 14, 20, 10];
</script>
<template>
  <section class="panel today-panel"><div class="section-heading"><h2>Today on the line</h2><span class="muted small">A quieter kind of busy</span></div>
    <div class="today-strip" role="img" aria-label="Sample phone activity across the day"><i v-for="(height, index) in levels" :key="index" :style="{ height: `${height}%` }" :class="{ coral: index === 15 || index === 24 }" /></div>
    <div class="time-axis"><span>06:00</span><span>10:00</span><span>14:00</span><span>18:00</span><span>22:00</span></div>
  </section>
</template>
