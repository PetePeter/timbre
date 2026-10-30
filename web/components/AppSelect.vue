<script setup lang="ts">
import { useAttrs } from 'vue';
import Select from 'primevue/select';
import { useThemeOverlayProps } from '../theme-overlay';

defineOptions({ inheritAttrs: false });
const overlayProps = useThemeOverlayProps();
const attrs = useAttrs();

const selectPassThrough = () => ({
  label: {
    'aria-describedby': attrs['aria-describedby'],
    'aria-invalid': attrs['aria-invalid'],
  },
});
</script>

<template>
  <Select v-bind="{ ...$attrs, ...overlayProps }" :pt="selectPassThrough()" />
</template>
