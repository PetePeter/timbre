<script setup lang="ts">
import { computed, ref, useAttrs, useId } from 'vue';
import type { AddressBookContact } from '../../src/contacts/contact.js';
import { matchContactsByNumber } from '../../src/contacts/match-number.js';

defineOptions({ inheritAttrs: false });
const props = defineProps<{ modelValue: string; contacts: AddressBookContact[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const attrs = useAttrs();
const listboxId = useId();
const open = ref(false);
const activeIndex = ref(-1);

const suggestions = computed(() => {
  const query = props.modelValue.trim();
  if (!query) return [];
  const lower = query.toLocaleLowerCase();
  const digits = query.replace(/\D/g, '');
  const equivalentMatches = new Set(matchContactsByNumber(props.contacts, query, null));
  return props.contacts.flatMap((contact) => {
    const nameMatch = contact.name.toLocaleLowerCase().includes(lower);
    const matchingNumbers = nameMatch
      ? contact.numbers
      : contact.numbers.filter((number) => number.toLocaleLowerCase().includes(lower)
        || (!!digits && number.replace(/\D/g, '').includes(digits))
        || equivalentMatches.has(contact));
    return matchingNumbers.map((number) => ({ contact, number }));
  }).slice(0, 8);
});

function update(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
  open.value = true;
  activeIndex.value = -1;
}

function select(number: string): void {
  emit('update:modelValue', number);
  open.value = false;
  activeIndex.value = -1;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    open.value = false;
    return;
  }
  if (!suggestions.value.length) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    open.value = true;
    activeIndex.value = (activeIndex.value + 1) % suggestions.value.length;
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    open.value = true;
    activeIndex.value = activeIndex.value <= 0 ? suggestions.value.length - 1 : activeIndex.value - 1;
  } else if (event.key === 'Enter' && open.value && activeIndex.value >= 0) {
    event.preventDefault();
    select(suggestions.value[activeIndex.value].number);
  }
}
</script>

<template>
  <div class="contact-number-input">
    <input
      v-bind="attrs"
      :value="modelValue"
      role="combobox"
      :aria-autocomplete="'list'"
      :aria-expanded="open && suggestions.length > 0"
      :aria-controls="listboxId"
      :aria-activedescendant="open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined"
      @input="update"
      @focus="open = true"
      @blur="open = false"
      @keydown="onKeydown"
    >
    <ul v-if="open && suggestions.length" :id="listboxId" class="contact-number-suggestions" role="listbox">
      <li v-for="({ contact, number }, index) in suggestions" :key="`${contact.id}-${number}`" role="presentation">
        <button
          type="button"
          role="option"
          :id="`${listboxId}-option-${index}`"
          :aria-selected="index === activeIndex"
          :aria-label="`Use ${contact.name} ${number}`"
          @mousedown.prevent
          @click="select(number)"
        >{{ contact.name }} — {{ number }}</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.contact-number-input { position: relative; }
.contact-number-suggestions { position: absolute; z-index: 2; top: 100%; left: 0; right: 0; display: grid; max-height: 14rem; overflow-y: auto; margin: 2px 0 0; padding: 4px; list-style: none; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: 0 8px 24px rgb(0 0 0 / 16%); }
.contact-number-suggestions button { width: 100%; padding: 8px; border: 0; border-radius: 5px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.contact-number-suggestions button:hover, .contact-number-suggestions button[aria-selected="true"] { background: var(--soft); }
</style>
