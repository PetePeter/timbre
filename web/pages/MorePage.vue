<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { moreDestinations } from '../navigation';
import NavigationIcon from '../components/NavigationIcon.vue';
</script>
<template>
  <div class="page-heading"><div><h1>More</h1><p>Your agent, phones and preferences.</p></div></div>
  <nav class="panel more-links" aria-label="More destinations"><RouterLink v-for="item in moreDestinations" :key="item.path" :to="item.path"><NavigationIcon :name="item.icon" />{{ item.title }}<span class="grow" /><span aria-hidden="true">›</span></RouterLink></nav>
</template>
