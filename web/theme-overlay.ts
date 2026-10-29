import { inject, provide, type InjectionKey } from 'vue';

export const themeOverlayHostId = 'timbre-overlay-host';
const themeOverlayHostSelector = `#${themeOverlayHostId}`;
const themeOverlayHostKey: InjectionKey<string> = Symbol('timbreThemeOverlayHost');

export function provideThemeOverlayHost() {
  provide(themeOverlayHostKey, themeOverlayHostSelector);
}

/** PrimeVue overlay wrappers share this target so portals stay inside the active theme. */
export function useThemeOverlayProps() {
  return { appendTo: inject(themeOverlayHostKey, themeOverlayHostSelector) };
}
