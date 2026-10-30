<script setup lang="ts">
import { useAttrs } from 'vue';
import InputNumber from 'primevue/inputnumber';

defineOptions({ inheritAttrs: false });
const attrs = useAttrs();

const inputPassThrough = () => ({
  pcInputText: {
    root: {
      'aria-describedby': attrs['aria-describedby'],
      'aria-invalid': attrs['aria-invalid'],
    },
  },
});
</script>

<template>
  <InputNumber v-bind="$attrs" :pt="inputPassThrough()" />
</template>
