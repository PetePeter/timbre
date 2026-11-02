<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { useAppState } from '../app-state';
import type { CallSkill } from '../api';

const state = useAppState();
const selectedId = ref('');
const error = ref('');
const skills = computed(() => state.cfg?.callSkills ?? []);
const selected = computed(() => skills.value.find((skill) => skill.id === selectedId.value));
const stepsText = computed({
  get: () => selected.value?.steps.join('\n') ?? '',
  set: (value: string) => { if (selected.value) selected.value.steps = lines(value); },
});
const allowedInfoText = computed({
  get: () => selected.value?.allowedInfo.join('\n') ?? '',
  set: (value: string) => { if (selected.value) selected.value.allowedInfo = lines(value); },
});

watch(skills, (items) => {
  if (!items.some((skill) => skill.id === selectedId.value)) selectedId.value = items[0]?.id ?? '';
}, { immediate: true });

function addSkill(): void {
  if (!state.cfg || state.busy) return;
  const skill: CallSkill = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, name: 'New call skill', description: '', goal: '',
    steps: [], allowedInfo: [],
    fields: [{ key: 'number', label: 'Phone number', required: true }],
  };
  state.cfg.callSkills.push(skill);
  selectedId.value = skill.id;
}

function removeSkill(): void {
  if (!state.cfg || !selected.value || state.busy) return;
  state.cfg.callSkills = state.cfg.callSkills.filter((skill) => skill.id !== selectedId.value);
}

function addField(): void {
  if (!selected.value || state.busy) return;
  const used = new Set(selected.value.fields.map((field) => field.key));
  let index = 1;
  while (used.has(`detail${index}`)) index++;
  selected.value.fields.push({ key: `detail${index}`, label: 'New detail', required: false });
}

function removeField(index: number): void {
  selected.value?.fields.splice(index, 1);
}

async function save(): Promise<void> {
  error.value = '';
  const issue = skills.value.map(skillError).find((message): message is string => !!message);
  if (issue) {
    error.value = issue;
    return;
  }
  await state.save();
  if (state.error) error.value = state.error;
}

function skillError(skill: CallSkill): string | null {
  if (!skill.name.trim() || !skill.description.trim() || !skill.goal.trim()) return 'Each skill needs a name, description and goal.';
  const keys = skill.fields.map((field) => field.key.trim());
  if (skill.fields.some((field) => !/^[a-z][a-zA-Z0-9_]*$/.test(field.key.trim()) || !field.label.trim())
    || new Set(keys).size !== keys.length) return 'Each detail needs a unique key such as “number” or “business” and a label.';
  if (!keys.includes('number') && !skill.defaultNumber?.trim()) return 'Each skill needs a “number” detail or a default phone number.';
  return null;
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}
</script>

<template>
  <div class="page-heading">
    <div><h1>Call skills</h1><p>Save reusable call instructions and the details to collect before a call.</p></div>
    <Button label="Add skill" :disabled="!state.cfg || state.busy" @click="addSkill" />
  </div>
  <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
  <div v-if="state.cfg" class="skill-layout">
    <nav class="panel stack skill-list" aria-label="Saved call skills">
      <h2>Saved skills</h2>
      <button
        v-for="skill in skills" :key="skill.id" type="button" class="skill-choice"
        :aria-pressed="skill.id === selectedId" @click="selectedId = skill.id"
      >
        <strong>{{ skill.name || 'Untitled skill' }}</strong>
        <small class="muted">{{ skill.description || 'Add a description' }}</small>
      </button>
      <p v-if="skills.length === 0" class="muted">No saved call skills.</p>
    </nav>

    <section v-if="selected" class="panel stack skill-editor" aria-label="Edit call skill">
      <div class="section-heading">
        <div><h2>Skill details</h2><p class="muted">The description helps an external agent choose this skill.</p></div>
        <Button label="Delete skill" severity="secondary" :disabled="state.busy" @click="removeSkill" />
      </div>
      <label class="field"><span>Name</span><InputText v-model="selected.name" aria-label="Skill name" maxlength="100" required :disabled="state.busy" /></label>
      <label class="field"><span>Description</span><textarea v-model="selected.description" aria-label="Skill description" rows="2" maxlength="800" required :disabled="state.busy" /></label>
      <label class="field"><span>Goal</span><textarea v-model="selected.goal" aria-label="Skill goal" rows="3" maxlength="2000" required :disabled="state.busy" /></label>
      <label class="field"><span>Steps and notes</span><textarea v-model="stepsText" aria-label="Skill steps" rows="4" placeholder="One step per line" :disabled="state.busy" /></label>
      <label class="field"><span>Information the agent may share</span><textarea v-model="allowedInfoText" aria-label="Allowed information" rows="3" placeholder="One item per line" :disabled="state.busy" /></label>
      <label class="field field-narrow"><span>Default phone number (optional)</span><InputText v-model="selected.defaultNumber" aria-label="Default phone number" type="tel" maxlength="120" :disabled="state.busy" /></label>

      <div class="skill-fields stack">
        <div class="section-heading"><div><h3>Details to collect</h3><p class="muted">Use “number” for the destination phone number.</p></div><Button label="Add detail" severity="secondary" :disabled="state.busy" @click="addField" /></div>
        <div v-for="(field, index) in selected.fields" :key="index" class="skill-field-row">
          <label class="field"><span>Key</span><InputText v-model="field.key" :aria-label="`Detail ${index + 1} key`" maxlength="40" pattern="[a-z][a-zA-Z0-9_]*" :disabled="state.busy" /></label>
          <label class="field"><span>Label</span><InputText v-model="field.label" :aria-label="`Detail ${index + 1} label`" maxlength="100" :disabled="state.busy" /></label>
          <label class="check"><input v-model="field.required" type="checkbox" :aria-label="`Detail ${index + 1} required`" :disabled="state.busy" /> Required</label>
          <Button label="Remove" severity="secondary" :aria-label="`Remove detail ${index + 1}`" :disabled="state.busy" @click="removeField(index)" />
        </div>
        <p v-if="selected.fields.length === 0" class="muted">No details are collected for this skill.</p>
      </div>

      <div class="skill-footer">
        <span class="muted">{{ state.dirty ? 'Unsaved changes' : 'All changes saved' }}</span>
        <Button label="Save skills" :disabled="!state.dirty || state.busy" :loading="state.busy" @click="save" />
      </div>
    </section>
    <section v-else class="panel empty-state"><h2>No skill selected</h2><p class="muted">Add a call skill to get started.</p></section>
  </div>
</template>

<style scoped>
.skill-layout { display: grid; grid-template-columns: minmax(220px, 300px) minmax(0, 1fr); align-items: start; gap: var(--gap); }
.skill-list { position: sticky; top: 96px; }
.skill-choice { display: grid; gap: 3px; text-align: left; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--text); padding: 12px; }
.skill-choice[aria-pressed="true"] { border-color: var(--brand); background: var(--brand-soft); }
.skill-choice small { line-height: 1.35; }
.skill-editor { min-width: 0; }
.skill-fields { gap: 12px; padding-top: 8px; border-top: 1px solid var(--line); }
.skill-field-row { display: grid; grid-template-columns: minmax(100px, .7fr) minmax(160px, 1fr) auto auto; gap: 12px; align-items: end; }
.skill-footer { display: flex; align-items: center; justify-content: flex-end; gap: 14px; padding-top: 8px; }
@media (max-width: 760px) { .skill-layout { grid-template-columns: 1fr; }.skill-list { position: static; }.skill-field-row { grid-template-columns: 1fr 1fr; }.skill-field-row .check, .skill-field-row :deep(.p-button) { justify-self: start; } }
</style>
