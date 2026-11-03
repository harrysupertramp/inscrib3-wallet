<script setup lang="ts" generic="T extends string">
export interface ToggleOption<T extends string> {
  value: T;
  label: string;
  caption?: string;
}

withDefaults(
  defineProps<{
    options: ToggleOption<T>[];
    modelValue: T;
    // 'card': bordered buttons with optional caption. 'pill': compact chips.
    variant?: 'card' | 'pill';
    disabled?: boolean;
  }>(),
  { variant: 'card', disabled: false },
);

defineEmits<{ 'update:modelValue': [value: T] }>();
</script>

<template>
  <div class="toggle-group" :class="variant">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      :class="{ active: modelValue === opt.value }"
      :disabled="disabled"
      @click="$emit('update:modelValue', opt.value)"
    >
      <span class="label">{{ opt.label }}</span>
      <span v-if="opt.caption" class="caption">{{ opt.caption }}</span>
    </button>
  </div>
</template>

<style scoped>
.toggle-group { display: flex; gap: 8px; }
.toggle-group button {
  display: flex;
  align-items: center;
  cursor: pointer;
  border-radius: 8px;
}
.toggle-group button:disabled { opacity: 0.5; cursor: not-allowed; }

.toggle-group.card button {
  flex: 1;
  /* lets 4+ options shrink to fit the 360px popup */
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  padding: 10px 8px;
}
.toggle-group.card button.active { border-color: var(--color-accent); }
.toggle-group.card button.active .label { color: var(--color-accent); }
.toggle-group.card button.active .caption { color: var(--color-accent); opacity: 0.75; }
.toggle-group.card .label { font-size: 13px; font-weight: 700; }
.toggle-group.card .caption { font-size: 10px; color: var(--color-text-muted); }

.toggle-group.pill { gap: 6px; overflow-x: auto; }
.toggle-group.pill button {
  flex-shrink: 0;
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 20px;
  color: var(--color-text-muted);
  padding: 6px 12px;
  white-space: nowrap;
}
.toggle-group.pill button.active {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-accent-text);
}
.toggle-group.pill .label { font-size: 12px; font-weight: 600; }
</style>
