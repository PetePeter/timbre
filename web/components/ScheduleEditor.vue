<script setup lang="ts">
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import InputText from 'primevue/inputtext';
import type { InboundHandlingPolicy } from '../../src/phone/inbound-call-policy.js';
import { createScheduleSlotId, type PhoneSchedule, type WeeklyScheduleSlot } from '../../src/phone/schedule.js';
import SchedulePolicyFields from './SchedulePolicyFields.vue';

const props = withDefaults(defineProps<{
  modelValue: PhoneSchedule;
  disabled?: boolean;
}>(), { disabled: false });
const emit = defineEmits<{ 'update:modelValue': [schedule: PhoneSchedule] }>();

const days = [
  { label: 'Sun', value: 0 }, { label: 'Mon', value: 1 }, { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 }, { label: 'Thu', value: 4 }, { label: 'Fri', value: 5 }, { label: 'Sat', value: 6 },
];

function updateSchedule(changes: Partial<PhoneSchedule>) {
  emit('update:modelValue', { ...props.modelValue, ...changes });
}

function updateSlot(index: number, changes: Partial<WeeklyScheduleSlot>) {
  const slots = [...props.modelValue.slots];
  slots[index] = { ...slots[index], ...changes };
  updateSchedule({ slots });
}

function updatePolicy(index: number, policy: InboundHandlingPolicy) {
  updateSlot(index, policy);
}

function setDay(index: number, day: number, checked: boolean) {
  const selected = new Set(props.modelValue.slots[index].days);
  if (checked) selected.add(day);
  else selected.delete(day);
  updateSlot(index, { days: [...selected].sort((a, b) => a - b) });
}

function addSlot() {
  const slot: WeeklyScheduleSlot = {
    id: createScheduleSlotId(), days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00',
    action: 'message', greeting: '', instructions: '', smsAutoReply: { mode: 'none', text: '' },
  };
  updateSchedule({ slots: [...props.modelValue.slots, slot] });
}

function removeSlot(index: number) {
  updateSchedule({ slots: props.modelValue.slots.filter((_, slotIndex) => slotIndex !== index) });
}
</script>

<template>
  <div class="schedule-editor" aria-label="Weekly call schedule">
    <label class="field timezone-field">
      <span>Phone time zone (IANA)</span>
      <InputText :model-value="modelValue.timeZone" aria-label="Schedule time zone" placeholder="Australia/Sydney" :disabled="disabled" @update:model-value="updateSchedule({ timeZone: String($event ?? '') })" />
      <small class="muted">Schedule times follow this phone’s time zone.</small>
    </label>

    <article v-for="(slot, index) in modelValue.slots" :key="slot.id" class="schedule-slot">
      <div class="slot-heading">
        <h3>Time slot {{ index + 1 }}</h3>
        <Button type="button" severity="secondary" text :aria-label="`Remove time slot ${index + 1}`" :disabled="disabled" @click="removeSlot(index)">Remove</Button>
      </div>
      <fieldset class="day-grid" :aria-label="`Days for time slot ${index + 1}`">
        <label v-for="day in days" :key="day.value" class="day-option" :for="`schedule-slot-${index}-day-${day.value}`">
          <Checkbox :input-id="`schedule-slot-${index}-day-${day.value}`" :model-value="slot.days.includes(day.value)" binary :disabled="disabled" @update:model-value="setDay(index, day.value, $event === true)" />
          <span>{{ day.label }}</span>
        </label>
      </fieldset>
      <div class="slot-times">
        <label class="field">
          <span>Start time</span>
          <InputText type="time" :model-value="slot.start" :aria-label="`Slot ${index + 1} start time`" :disabled="disabled" @update:model-value="updateSlot(index, { start: String($event ?? '') })" />
        </label>
        <label class="field">
          <span>End time</span>
          <InputText type="time" :model-value="slot.end" :aria-label="`Slot ${index + 1} end time`" :disabled="disabled" @update:model-value="updateSlot(index, { end: String($event ?? '') })" />
        </label>
      </div>
      <SchedulePolicyFields :model-value="slot" label-context="Schedule slot" :disabled="disabled" @update:model-value="updatePolicy(index, $event)" />
    </article>

    <p v-if="!modelValue.slots.length" class="muted empty-schedule">No weekly schedule slots. Calls use the default handling policy.</p>
    <Button type="button" label="Add schedule slot" aria-label="Add schedule slot" :disabled="disabled" @click="addSlot" />
  </div>
</template>

<style scoped>
.schedule-editor { display: grid; gap: 16px; margin-top: 18px; }
.field { display: grid; gap: 6px; min-width: 0; }
.field > span { color: var(--muted); font-size: .9rem; }
.timezone-field { max-width: 560px; }
.schedule-slot { display: grid; gap: 14px; border: 1px solid var(--line); border-radius: 10px; padding: 14px; background: var(--surface-soft, var(--surface)); }
.slot-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.slot-heading h3 { margin: 0; font-size: 1rem; }
.day-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 0; border: 0; }
.day-option { display: flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 4px; }
.slot-times { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.empty-schedule { margin: 0; }
@media (max-width: 640px) {
  .day-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .slot-times { grid-template-columns: 1fr; }
}
</style>
