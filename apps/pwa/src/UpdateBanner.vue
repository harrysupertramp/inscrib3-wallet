<script setup lang="ts">
import { useRegisterSW } from 'virtual:pwa-register/vue';

// With registerType 'prompt' a new service worker waits until the user
// reloads; dismissing only hides this banner.
const { needRefresh, updateServiceWorker } = useRegisterSW();

function reload() {
  void updateServiceWorker(true);
}

function dismiss() {
  needRefresh.value = false;
}
</script>

<template>
  <div v-if="needRefresh" class="update-banner">
    <span>A new version is available.</span>
    <div class="actions">
      <button type="button" class="reload-btn" @click="reload">Reload</button>
      <button type="button" class="dismiss-btn" @click="dismiss" aria-label="Dismiss">✕</button>
    </div>
  </div>
</template>

<style scoped>
.update-banner {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border-accent);
  border-radius: 12px;
  padding: 10px 14px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  font-size: 13px;
  color: var(--color-text);
  max-width: calc(100vw - 32px);
}
.actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.reload-btn {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border: none;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.dismiss-btn {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 2px 4px;
}
</style>
