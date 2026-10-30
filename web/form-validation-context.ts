import { computed, reactive, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue';

export interface FormValidationContext {
  attempted: Ref<boolean>;
  hasErrors: ComputedRef<boolean>;
  register: (id: string, invalid: ComputedRef<boolean>) => () => void;
  validate: () => boolean;
}

export const formValidationContextKey: InjectionKey<FormValidationContext> = Symbol('Timbre form validation');

export function createFormValidationContext(): FormValidationContext {
  const fields = reactive(new Map<string, ComputedRef<boolean>>());
  const attempted = ref(false);
  const hasErrors = computed(() => [...fields.values()].some((invalid) => invalid.value));

  return {
    attempted,
    hasErrors,
    register(id, invalid) {
      fields.set(id, invalid);
      return () => fields.delete(id);
    },
    validate() {
      attempted.value = true;
      return !hasErrors.value;
    },
  };
}
