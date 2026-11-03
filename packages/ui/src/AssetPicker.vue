<script setup lang="ts" generic="T extends string">
import { computed, onUnmounted, ref, watch } from 'vue';
import Icon from './Icon.vue';

// iconLetter stands in for an asset without a logo.
export interface AssetPickerOption<T extends string> {
  value: T;
  label: string;
  amount: string;
  iconLetter: string;
  iconUrl?: string;
}

const props = defineProps<{
  options: AssetPickerOption<T>[];
  modelValue: T;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: T] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const selected = computed(() => props.options.find((o) => o.value === props.modelValue) ?? null);

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
}

function select(value: T) {
  emit('update:modelValue', value);
  open.value = false;
}

function onClickOutside(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener('click', onClickOutside, true);
  else document.removeEventListener('click', onClickOutside, true);
});
onUnmounted(() => document.removeEventListener('click', onClickOutside, true));
</script>

<template>
  <div class="asset-picker" ref="root">
    <button type="button" class="picker-trigger" @click="toggle" :disabled="disabled">
      <template v-if="selected">
        <span class="picker-icon"><img v-if="selected.iconUrl" :src="selected.iconUrl" :alt="selected.label" referrerpolicy="no-referrer" loading="lazy" /><template v-else>{{ selected.iconLetter }}</template></span>
        <span class="picker-name">{{ selected.label }}</span>
        <span class="picker-amount">{{ selected.amount }}</span>
      </template>
      <span v-else class="picker-name placeholder">Select…</span>
      <Icon :name="open ? 'arrow-up' : 'arrow-down'" :size="14" />
    </button>

    <div v-if="open" class="picker-menu">
      <button
        type="button"
        class="picker-option"
        v-for="opt in options"
        :key="opt.value"
        :class="{ active: opt.value === modelValue }"
        @click="select(opt.value)"
      >
        <span class="picker-icon"><img v-if="opt.iconUrl" :src="opt.iconUrl" :alt="opt.label" referrerpolicy="no-referrer" loading="lazy" /><template v-else>{{ opt.iconLetter }}</template></span>
        <span class="picker-name">{{ opt.label }}</span>
        <span class="picker-amount">{{ opt.amount }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.asset-picker { position: relative; }
.picker-trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text);
  cursor: pointer;
  padding: 8px 12px;
}
.picker-trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.picker-icon {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-surface);
  color: var(--color-accent-secondary);
  font-weight: 700;
  font-size: 13px;
}
.picker-icon img { width: 100%; height: 100%; object-fit: cover; }
.picker-name { flex: 1; min-width: 0; text-align: left; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker-name.placeholder { color: var(--color-text-muted); font-weight: 400; }
.picker-amount { font-size: 13px; font-family: monospace; color: var(--color-text-muted); flex-shrink: 0; text-align: right; }
.picker-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 20;
  max-height: 240px;
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  padding: 4px;
}
.picker-option {
  display: flex;
  align-items: center;
  gap: 10px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--color-text);
  cursor: pointer;
  padding: 8px;
  text-align: left;
  width: 100%;
}
.picker-option:hover { background: var(--color-surface-alt); }
.picker-option.active { background: var(--color-surface-alt); }
.picker-option.active .picker-name { color: var(--color-accent); }
</style>
