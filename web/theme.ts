import { ref } from 'vue';
import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

const surface = {
  0: '#FFFFFF', 50: '#F6F1EA', 100: '#F4EEE6', 200: '#E6DCCF', 300: '#D0C4BC',
  400: '#A39AAD', 500: '#6B6177', 600: '#594F63', 700: '#453C4E', 800: '#352D3E', 900: '#2A2233', 950: '#1B1722',
};
export const TimbrePreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#E3F2FC', 100: '#CBE7FA', 200: '#AAD7F5', 300: '#7DC4F0', 400: '#56B0E9',
      500: '#2F9BE0', 600: '#2083C1', 700: '#1D6898', 800: '#20577C', 900: '#204967', 950: '#152F45',
    },
    colorScheme: {
      light: { surface, primary: { color: '{primary.500}', inverseColor: '{primary.950}', hoverColor: '{primary.600}', activeColor: '{primary.700}' } },
      dark: { surface, primary: { color: '{primary.400}', inverseColor: '{surface.950}', hoverColor: '{primary.300}', activeColor: '{primary.200}' } },
    },
  },
});

type Theme = 'light' | 'dark';
const isTheme = (value: string | null): value is Theme => value === 'light' || value === 'dark';

/** A URL preference also makes either appearance directly previewable. */
export function createThemePreference() {
  const requested = new URLSearchParams(location.search).get('theme');
  let stored: string | null = null;
  try { stored = localStorage.getItem('timbre.theme'); } catch { /* Storage may be disabled. */ }
  const mode = ref<Theme>(isTheme(requested) ? requested : isTheme(stored) ? stored : 'light');
  function toggle() {
    mode.value = mode.value === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('timbre.theme', mode.value); } catch { /* Theme still works without storage. */ }
  }
  return { mode, toggle };
}
