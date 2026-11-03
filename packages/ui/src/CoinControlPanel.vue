<script setup lang="ts">
import Icon from './Icon.vue';

// The "Advanced: choose coins" frame shared by every send form. Each form
// fills the rows through the slot; the row styles live here (:slotted).
defineProps<{
  open: boolean;
  loading: boolean;
  error: string;
  isEmpty: boolean;
  emptyText: string;
  selectedCount: number;
  disabled?: boolean;
}>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <div class="coin-control">
    <button type="button" class="coin-control-toggle" :disabled="disabled" @click="$emit('toggle')">
      <span class="section-title">Advanced: choose coins{{ selectedCount > 0 ? ` (${selectedCount})` : '' }}</span>
      <Icon :name="open ? 'arrow-up' : 'arrow-down'" :size="14" />
    </button>
    <div v-if="open" class="coin-control-list">
      <p v-if="loading" class="hint">Loading…</p>
      <p v-else-if="error" class="error">{{ error }}</p>
      <p v-else-if="isEmpty" class="hint">{{ emptyText }}</p>
      <slot v-else />
    </div>
  </div>
</template>

<style scoped>
.coin-control {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}
.coin-control-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 12px;
}
.coin-control-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
.section-title { font-size: 12px; color: var(--color-text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.coin-control-list { display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; }
.hint { color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.error { color: var(--color-error); font-size: 13px; }
:slotted(.coin-row) {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 10px;
  cursor: pointer;
}
:slotted(.coin-row input) { width: auto; }
:slotted(.coin-details) { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
:slotted(.coin-amount) { font-size: 13px; font-weight: 700; font-family: monospace; color: var(--color-text); flex: 1; }
:slotted(.coin-note) { font-size: 11px; color: var(--color-accent); }
:slotted(.coin-status) { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 6px; border-radius: 4px; }
:slotted(.coin-status.settled) { background: #0d1f0d; color: #4caf50; }
:slotted(.coin-status.preconfirmed) { background: #1f1a0d; color: #e0a030; }
:slotted(.coin-total) { margin-top: -2px; }
:slotted(.coin-total.error) { color: var(--color-error); }
</style>
