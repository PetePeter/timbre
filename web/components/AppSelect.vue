<script setup lang="ts">
import Select from 'primevue/select';
import { useThemeOverlayProps } from '../theme-overlay';

defineOptions({ inheritAttrs: false });
const overlayProps = useThemeOverlayProps();
</script>

<template>
  <Select v-bind="{ ...$attrs, ...overlayProps }" />
</template>
