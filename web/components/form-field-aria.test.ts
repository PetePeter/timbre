// @vitest-environment happy-dom
import { h, defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { describe, expect, it } from 'vitest';
import AppInputNumber from './AppInputNumber.vue';
import AppSelect from './AppSelect.vue';
import FormField from './FormField.vue';

const SelectField = defineComponent({
  setup() {
    return () => h(FormField, {
      value: 'first',
      hint: 'Choose an option.',
      validate: () => 'Choose another option.',
    }, {
      default: ({ inputAttrs }: { inputAttrs: Record<string, unknown> }) => h(AppSelect, {
        ...inputAttrs,
        modelValue: 'first',
        options: [{ label: 'First', value: 'first' }],
        'aria-label': 'Test select',
      }),
    });
  },
});

const NumberField = defineComponent({
  setup() {
    return () => h(FormField, {
      value: 1,
      hint: 'Enter a number.',
      validate: () => 'The number is invalid.',
    }, {
      default: ({ inputAttrs }: { inputAttrs: Record<string, unknown> }) => h(AppInputNumber, {
        ...inputAttrs,
        modelValue: 1,
        'aria-label': 'Test number',
      }),
    });
  },
});

function mountField(component: ReturnType<typeof defineComponent>) {
  const overlayHost = document.createElement('div');
  overlayHost.id = 'timbre-overlay-host';
  document.body.append(overlayHost);
  const wrapper = mount(component, {
    global: { plugins: [[PrimeVue, { unstyled: true }]] },
  });
  return {
    wrapper,
    cleanup: () => {
      wrapper.unmount();
      overlayHost.remove();
    },
  };
}

describe('FormField ARIA wiring', () => {
  it('associates the Select hint and error with its focusable combobox', () => {
    const { wrapper, cleanup } = mountField(SelectField);
    const control = wrapper.get('[role="combobox"]');
    const hintId = wrapper.get('.form-field-hint').attributes('id');
    const errorId = wrapper.get('.form-field-error').attributes('id');

    expect(control.attributes('aria-describedby')?.split(' ')).toEqual([hintId, errorId]);
    expect(control.attributes('aria-invalid')).toBe('true');
    cleanup();
  });

  it('associates the InputNumber hint and error with its focusable spinbutton', () => {
    const { wrapper, cleanup } = mountField(NumberField);
    const control = wrapper.get('[role="spinbutton"]');
    const hintId = wrapper.get('.form-field-hint').attributes('id');
    const errorId = wrapper.get('.form-field-error').attributes('id');

    expect(control.attributes('aria-describedby')?.split(' ')).toEqual([hintId, errorId]);
    expect(control.attributes('aria-invalid')).toBe('true');
    cleanup();
  });
});
