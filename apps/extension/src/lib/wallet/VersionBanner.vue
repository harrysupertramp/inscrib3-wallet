<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getVersionInfo, dismissVersionUpdate } from './version-client.js';

const updateAvailable = ref(false);
const latestVersion = ref<string | null>(null);
const releaseUrl = ref<string | null>(null);

onMounted(async () => {
  try {
    const info = await getVersionInfo();
    updateAvailable.value = info.updateAvailable;
    latestVersion.value = info.latestVersion;
    releaseUrl.value = info.releaseUrl;
  } catch {
    // no cached check yet, or the background call failed - just stay hidden
  }
});

function dismiss() {
  updateAvailable.value = false;
  if (latestVersion.value) void dismissVersionUpdate(latestVersion.value);
}
</script>

<template>
  <div v-if="updateAvailable" class="version-banner">
    <span class="text">
      New version{{ latestVersion ? ` ${latestVersion}` : '' }} available
      <a v-if="releaseUrl" :href="releaseUrl" target="_blank" rel="noopener noreferrer">Download</a>
    </span>
    <button type="button" class="dismiss-btn" @click="dismiss" aria-label="Dismiss">✕</button>
  </div>
</template>

<style scoped>
.version-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--color-surface-alt);
  border-bottom: 1px solid var(--color-border-accent);
  padding: 8px 12px;
  font-size: 12px;
  color: var(--color-text);
}
.text { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.text a {
  color: var(--color-accent);
  font-weight: 600;
  text-decoration: none;
}
.text a:hover { text-decoration: underline; }
.dismiss-btn {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 4px;
  flex-shrink: 0;
}
</style>
