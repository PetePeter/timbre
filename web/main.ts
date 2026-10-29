import { createApp } from 'vue';
import App from './App.vue';
import PrimeVue from 'primevue/config';
import { createAppRouter } from './router';
import { TimbrePreset } from './theme';
import './style.css';

createApp(App)
  .use(createAppRouter())
  .use(PrimeVue, { theme: { preset: TimbrePreset, options: { darkModeSelector: '.timbre-dark' } } })
  .mount('#app');
