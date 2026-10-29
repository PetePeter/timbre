<script setup lang="ts">
import { ref } from 'vue';
import SelectButton from 'primevue/selectbutton';
import Button from 'primevue/button';

const lanes = [
  { title: 'Needs you', tone: 'coral', items: [
    { name: 'Delivery team', note: 'A quick check on tomorrow’s delivery window.', time: '12 min ago', action: 'Call back', type: '↙' },
    { name: 'Appointment reminder', note: 'Friday at 10:00. Ready to confirm?', time: '38 min ago', action: 'Mark done', type: '↙' },
  ] },
  { title: 'Agent handled', tone: 'sky', items: [
    { name: 'A friend', note: 'Asked if you’re around. Your agent replied.', time: '10:42', action: '', type: '✉' },
    { name: 'Service booking', note: 'A time arranged for next Tuesday.', time: '09:30', action: '', type: '↗' },
    { name: 'Courier', note: 'Parcel left in your safe place.', time: '08:56', action: '', type: '↙' },
  ] },
  { title: 'Kept out', tone: 'rose', items: [
    { name: 'Unknown caller', note: 'Screened as a likely spam call.', time: '11:16', action: '', type: '⊘' },
    { name: 'Private number', note: 'Private numbers weren’t allowed through.', time: '08:20', action: '', type: '⊘' },
  ] },
];
const selected = ref(lanes[0].title);
</script>
<template>
  <SelectButton v-model="selected" class="lane-selector" :options="lanes.map((lane) => lane.title)" :allow-empty="false" aria-label="Activity lane" />
  <div class="activity-board">
    <section v-for="lane in lanes" :key="lane.title" class="activity-lane" :class="{ 'mobile-hidden': lane.title !== selected }">
      <div class="lane-heading"><h2>{{ lane.title }}</h2><span class="pill" :class="lane.tone">{{ lane.items.length }}</span></div>
      <article v-for="item in lane.items" :key="item.name" class="activity-card">
        <h3>{{ item.name }}</h3><p><span class="activity-kind" :class="lane.tone" aria-hidden="true">{{ item.type }}</span> {{ item.note }}</p>
        <Button v-if="item.action" :label="item.action" size="small" severity="secondary" disabled title="Sample activity" />
      </article>
      <p class="lane-footnote">{{ lane.title === 'Needs you' ? 'A small list. On your terms.' : lane.title === 'Agent handled' ? 'Taken care of, without interrupting.' : 'A little less noise in your day.' }}</p>
    </section>
  </div>
</template>
