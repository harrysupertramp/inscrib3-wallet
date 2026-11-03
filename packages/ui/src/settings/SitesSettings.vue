<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useWalletClient } from '../wallet-client-key.js';

const client = useWalletClient();

const connectedOrigins = ref<string[]>([]);
const connectedOriginsLoading = ref(false);
const connectedOriginsError = ref('');
const revokingOrigin = ref('');

async function loadConnectedOrigins() {
  if (!client.getConnectedOrigins) return;
  connectedOriginsLoading.value = true;
  connectedOriginsError.value = '';
  try {
    connectedOrigins.value = await client.getConnectedOrigins();
  } catch (e: unknown) {
    connectedOriginsError.value = String(e);
  } finally {
    connectedOriginsLoading.value = false;
  }
}

async function revokeConnectedOrigin(origin: string) {
  if (!client.revokeOrigin) return;
  revokingOrigin.value = origin;
  connectedOriginsError.value = '';
  try {
    await client.revokeOrigin(origin);
    connectedOrigins.value = connectedOrigins.value.filter((o) => o !== origin);
  } catch (e: unknown) {
    connectedOriginsError.value = String(e);
  } finally {
    revokingOrigin.value = '';
  }
}

onMounted(loadConnectedOrigins);
</script>

<template>
  <section class="settings-view">
    <p class="hint">Sites you've approved a connection to. Revoking one means it'll need to ask again before it can see your address or request a transaction.</p>
    <p v-if="connectedOriginsLoading" class="hint">Loading…</p>
    <p v-else-if="connectedOriginsError" class="error">{{ connectedOriginsError }}</p>
    <p v-else-if="connectedOrigins.length === 0" class="hint">No connected sites.</p>
    <div v-else class="origin-list">
      <div class="origin-row" v-for="origin in connectedOrigins" :key="origin">
        <span class="origin-text">{{ origin }}</span>
        <button
          type="button"
          class="secondary revoke-btn"
          :disabled="revokingOrigin === origin"
          @click="revokeConnectedOrigin(origin)"
        >
          {{ revokingOrigin === origin ? 'Revoking…' : 'Revoke' }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.origin-text { font-size: 13px; color: var(--color-text); word-break: break-all; }
</style>
