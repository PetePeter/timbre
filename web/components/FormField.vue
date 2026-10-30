<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { formValidationContextKey } from '../form-validation-context';

const props = withDefaults(defineProps<{
  value?: unknown;
  hint: string;
  validate?: (value: unknown) => string | null;
  serverError?: string;
  attempted?: boolean;
  blockSave?: boolean;
}>(), { attempted: false, blockSave: true });

defineSlots<{
  default: (props: {
    inputAttrs: {
      'aria-invalid': boolean | undefined;
      'aria-describedby': string;
    };
  }) => unknown;
}>();

const fieldId = useId();
const touched = ref(false);
const validationContext = inject(formValidationContextKey, null);
const error = computed(() => props.serverError || props.validate?.(props.value) || '');
const invalid = computed(() => !!error.value);
const hasValue = computed(() => Array.isArray(props.value)
  ? props.value.length > 0
  : props.value !== undefined && props.value !== null && props.value !== '');
const showError = computed(() => invalid.value && (touched.value || hasValue.value || !!props.serverError || props.attempted || (props.blockSave && !!validationContext?.attempted.value)));
const inputAttrs = computed(() => ({
  'aria-invalid': showError.value ? true : undefined,
  'aria-describedby': showError.value ? `${fieldId}-hint ${fieldId}-error` : `${fieldId}-hint`,
}));
let unregister: (() => void) | undefined;
onMounted(() => { if (props.blockSave) unregister = validationContext?.register(fieldId, invalid); });
onBeforeUnmount(() => unregister?.());
</script>

<template>
  <div class="form-field-feedback" @focusout="touched = true" @invalid.capture="touched = true">
    <slot :input-attrs="inputAttrs" />
    <small :id="`${fieldId}-hint`" class="form-field-hint">{{ hint }}</small>
    <small v-if="showError" :id="`${fieldId}-error`" class="form-field-error" role="alert">{{ error }}</small>
  </div>
</template>

<style scoped>
.form-field-feedback { display: grid; gap: 3px; min-width: 0; }
.form-field-hint, .form-field-error { font-size: .8rem; font-weight: 400; line-height: 1.4; }
.form-field-hint { color: var(--muted); }
.form-field-error { color: var(--rose); }
</style>
