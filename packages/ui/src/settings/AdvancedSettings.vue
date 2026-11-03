<script setup lang="ts">
import { ref } from 'vue';
import { useWalletClient } from '../wallet-client-key.js';

const client = useWalletClient();

// Only clears the local VTXO/tx cache, never the seed. Two-step confirm.
const resetConfirming = ref(false);
const resetPassword = ref('');
const resetLoading = ref(false);
const resetError = ref('');
const resetSuccess = ref(false);

function startReset() {
  resetError.value = '';
  resetSuccess.value = false;
  resetConfirming.value = true;
}

function cancelReset() {
  resetConfirming.value = false;
  resetPassword.value = '';
  resetError.value = '';
}

async function confirmReset() {
  if (!client.resetLocalCache) return;
  resetError.value = '';
  resetLoading.value = true;
  try {
    await client.resetLocalCache(resetPassword.value);
    resetSuccess.value = true;
    resetConfirming.value = false;
  } catch (e: unknown) {
    const msg = String(e);
    resetError.value = msg.includes('INCORRECT_PASSWORD')
      ? 'Incorrect password'
      : msg.includes('SERVER_UNREACHABLE')
        ? 'Could not reach the Ark server - try again'
        : msg;
  } finally {
    resetLoading.value = false;
    resetPassword.value = '';
  }
}
</script>

<template>
  <section class="settings-view">
    <p class="hint warning">
      Wipes this wallet's local VTXO/transaction cache and re-syncs from the Ark server. Your seed phrase is never touched - this can't lose funds, but any not-yet-synced local state is discarded.
    </p>

    <template v-if="!resetConfirming">
      <p v-if="resetSuccess" class="success-hint">Local cache reset. Balance and history have been re-synced.</p>
      <button type="button" class="secondary" @click="startReset">Reset local cache…</button>
    </template>

    <template v-else>
      <label>
        Password
        <input
          type="password"
          placeholder="Enter your password"
          v-model="resetPassword"
          @keydown.enter="confirmReset"
        />
      </label>
      <p v-if="resetError" class="error">{{ resetError }}</p>
      <button type="button" class="danger" @click="confirmReset" :disabled="resetLoading || !resetPassword">
        {{ resetLoading ? 'Resetting…' : 'Yes, wipe local cache and re-sync' }}
      </button>
      <button type="button" class="secondary" @click="cancelReset" :disabled="resetLoading">Cancel</button>
    </template>
  </section>
</template>
