<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router';

interface GuideActionLink {
  label: string;
  to?: RouteLocationRaw;
  href?: string;
}

defineProps<{
  number: number;
  title: string;
  description: string;
  done: boolean;
  to: RouteLocationRaw;
  action: string;
  extraActions?: GuideActionLink[];
}>();
</script>

<template>
  <li class="guide-step" :data-guide-step="number">
    <article class="panel guide-card">
      <div class="guide-step-main">
        <span class="guide-step-number" aria-hidden="true">{{ number }}</span>
        <div class="guide-step-copy">
          <h2>{{ title }}</h2>
          <p>{{ description }}</p>
        </div>
        <span class="pill guide-status" :class="done ? 'green' : 'sample-label'" :aria-label="done ? 'Done' : 'Not done'">
          {{ done ? 'Done' : 'Not done' }}
        </span>
      </div>
      <div class="guide-step-actions">
        <RouterLink class="guide-step-action" :to="to">{{ action }} <span aria-hidden="true">→</span></RouterLink>
        <template v-for="extra in extraActions" :key="extra.label">
          <RouterLink v-if="extra.to" class="guide-step-secondary" :to="extra.to">{{ extra.label }}</RouterLink>
          <a v-else-if="extra.href" class="guide-step-secondary" :href="extra.href" target="_blank" rel="noreferrer">{{ extra.label }}</a>
        </template>
      </div>
    </article>
  </li>
</template>

<style scoped>
.guide-card { display: grid; gap: 14px; padding: 18px 20px; }
.guide-step-main { display: flex; align-items: flex-start; gap: 13px; }
.guide-step-number { display: grid; flex: 0 0 30px; height: 30px; place-items: center; border-radius: 50%; background: var(--brand-soft); color: var(--brand-ink); font-size: 13px; font-weight: 750; }
.guide-step-copy { min-width: 0; flex: 1; }
.guide-step-copy h2 { margin: 2px 0 5px; font-size: 1rem; }
.guide-step-copy p { margin: 0; color: var(--muted); font-size: .92rem; line-height: 1.45; }
.guide-status { flex: 0 0 auto; margin-left: 8px; }
.guide-step-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; margin-left: 43px; }
.guide-step-action { display: inline-flex; width: fit-content; align-items: center; gap: 8px; color: var(--brand-ink); font-size: .9rem; font-weight: 650; text-decoration: none; }
.guide-step-secondary { color: var(--muted); font-size: .9rem; text-decoration: underline; text-underline-offset: 3px; }
.guide-step-action:hover, .guide-step-secondary:hover { text-decoration: underline; }
@media (max-width: 520px) {
  .guide-card { padding: 15px; }
  .guide-step-main { flex-wrap: wrap; }
  .guide-status { margin-left: 43px; }
  .guide-step-actions { margin-left: 43px; }
}
</style>
