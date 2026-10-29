<script setup lang="ts">
import { ref } from 'vue';
import Button from 'primevue/button';
import { RouterView } from 'vue-router';
import AppNavigation from './components/AppNavigation.vue';
import { provideAppState } from './app-state';
import { createThemePreference } from './theme';
import { provideThemeOverlayHost, themeOverlayHostId } from './theme-overlay';

const state = provideAppState();
const theme = createThemePreference();
const mainContent = ref<HTMLElement | null>(null);
provideThemeOverlayHost();

function focusMainContent() {
  mainContent.value?.focus();
}
</script>

<template>
  <div class="app-root" :class="{ 'timbre-dark': theme.mode.value === 'dark' }">
    <AppNavigation :mode="theme.mode.value" @toggle-theme="theme.toggle" @skip-to-content="focusMainContent" />
    <main id="main-content" ref="mainContent" class="app-main" tabindex="-1">
      <p v-if="state.error" class="error-banner" role="alert">{{ state.error }}</p>
      <RouterView />
      <p v-if="!state.cfg && state.busy" class="muted" role="status">Loading your phones…</p>
    </main>
    <footer v-if="state.dirty" class="savebar" aria-label="Configuration changes">
      <span class="grow">Unsaved changes</span>
      <Button label="Discard" severity="secondary" data-action="discard" :disabled="state.busy" @click="state.discard" />
      <Button label="Save" data-action="save" :loading="state.busy" @click="state.save" />
    </footer>
    <div :id="themeOverlayHostId" class="overlay-host" />
  </div>
</template>
