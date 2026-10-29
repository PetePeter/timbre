<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import NavigationIcon from '../components/NavigationIcon.vue';
const route = useRoute();
const copy = computed(() => ({
  Log: { title: 'Every call and text, in one place.', body: 'Your conversations, messages and the actions Timbre took will appear here.', icon: 'log' },
  People: { title: 'The right people, at the right time.', body: 'Manage your contacts, who can reach you, and their schedules here.', icon: 'people' },
  Insights: { title: 'Get a feel for your phone day.', body: 'See how callers get on with your agent, with useful trends over time.', icon: 'insights' },
}[String(route.meta.title)]));
</script>
<template>
  <div class="page-heading"><div><h1>{{ route.meta.title }}</h1><p>{{ copy?.title }}</p></div></div>
  <section class="panel empty-state"><span class="empty-icon"><NavigationIcon :name="copy?.icon || 'home'" /></span><h2>A space for what comes next</h2><p>{{ copy?.body }}</p><span class="pill sky">Coming soon</span></section>
</template>
