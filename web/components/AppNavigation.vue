<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
import { useAppState } from '../app-state';
import { destinations, mobileDestinations, moreDestinations } from '../navigation';
import BrandLogo from './BrandLogo.vue';
import NavigationIcon from './NavigationIcon.vue';

defineProps<{ mode: 'light' | 'dark' }>();
defineEmits<{ toggleTheme: []; skipToContent: [] }>();
const state = useAppState();
const route = useRoute();
const isMore = () => moreDestinations.some((item) => item.path === route.path);
</script>

<template>
  <a class="skip-link" href="#main-content" @click.prevent="$emit('skipToContent')">Skip to content</a>
  <header class="topbar">
    <RouterLink to="/" class="brand" aria-label="Timbre home"><BrandLogo /><span>Timbre</span></RouterLink>
    <nav class="desktop-tabs" aria-label="Main navigation" data-nav="desktop">
      <RouterLink v-for="item in destinations" :key="item.path" :to="item.path" exact-active-class="active">{{ item.title }}</RouterLink>
    </nav>
    <div class="header-actions">
      <div v-if="state.cfg" class="phone-chips" role="group" aria-label="Selected phone">
        <button v-for="phone in state.cfg.phones" :key="phone.id" class="phone-chip" :class="{ active: state.selectedPhone?.id === phone.id }" :aria-pressed="state.selectedPhone?.id === phone.id" @click="state.selectedId = phone.id">
          <span aria-hidden="true">{{ phone.line.enabled ? '●' : '○' }}</span> {{ phone.name }}
        </button>
      </div>
      <button class="theme-button" :aria-label="mode === 'light' ? 'Switch to dark theme' : 'Switch to light theme'" @click="$emit('toggleTheme')">{{ mode === 'light' ? '☾' : '☀' }}</button>
    </div>
  </header>
  <nav class="bottom-tabs" aria-label="Mobile navigation" data-nav="mobile">
    <RouterLink v-for="item in mobileDestinations" :key="item.path" :to="item.path" :class="{ active: item.path === '/more' && isMore() }" exact-active-class="active"><span><NavigationIcon :name="item.icon" /></span>{{ item.title }}</RouterLink>
  </nav>
</template>
