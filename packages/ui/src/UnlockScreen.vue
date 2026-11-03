<script setup lang="ts">
import { ref } from 'vue';
import { useWalletClient } from './wallet-client-key.js';

const client = useWalletClient();
const emit = defineEmits<{ unlocked: [] }>();

const password = ref('');
const error = ref('');
// Raw error text shown under the friendly message, so bug reports say what
// actually failed. Network/protocol errors only - nothing about wallet contents.
const errorDetail = ref('');
const loading = ref(false);
// Offered on SERVER_UNREACHABLE: usually the active account fails to
// initialize, and the switcher is only reachable after unlocking.
const showRecovery = ref(false);
const recovering = ref(false);
const recoveryDone = ref(false);

async function unlock() {
  if (!password.value) return;
  loading.value = true;
  error.value = '';
  errorDetail.value = '';
  showRecovery.value = false;
  recoveryDone.value = false;
  try {
    await client.unlock(password.value);
    password.value = '';
    emit('unlocked');
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes('SERVER_UNREACHABLE')) {
      error.value = "Password was correct, but couldn't reach the Ark server. Check your network settings and try again.";
      errorDetail.value = msg;
      showRecovery.value = true;
    } else if (msg.includes('WALLET_DATA_CORRUPTED')) {
      error.value = 'Your saved wallet data appears to be corrupted. This is not a password problem - retrying will not help.';
    } else {
      error.value = 'Incorrect password';
    }
    password.value = '';
  } finally {
    loading.value = false;
  }
}

async function resetToPrimaryAccount() {
  recovering.value = true;
  try {
    await client.resetToPrimaryAccount();
    recoveryDone.value = true;
    showRecovery.value = false;
  } catch (e: unknown) {
    error.value = String(e);
  } finally {
    recovering.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  // Key-repeat on a held Enter would fire overlapping unlocks.
  if (e.key === 'Enter' && !loading.value && password.value) unlock();
}
</script>

<template>
  <div class="unlock">
    <img class="logo" src="/image/inscrib3_logo.png" alt="Inscrib3" />
    <p class="subtitle">Insert your password</p>

    <input
      type="password"
      placeholder="Password"
      v-model="password"
      @keydown="onKeydown"
    />

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="errorDetail" class="error-detail">{{ errorDetail }}</p>
    <p v-if="recoveryDone" class="success-hint">Reset - enter your password and try again.</p>

    <button @click="unlock" :disabled="loading || !password">
      {{ loading ? 'Unlocking…' : 'Unlock' }}
    </button>

    <template v-if="showRecovery">
      <p class="subtitle recovery-hint">
        If you recently switched accounts, the one left active may not be reachable. You can reset back to your
        primary account (seed 0) without losing anything - your seed and every account's data stay exactly as they are.
      </p>
      <button type="button" class="secondary" @click="resetToPrimaryAccount" :disabled="recovering">
        {{ recovering ? 'Resetting…' : 'Reset to primary account' }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.unlock {
  padding: 48px 24px 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  min-height: 100vh;
}
.logo { width: 48px; height: 57px; object-fit: contain; }
.subtitle { color: var(--color-text-muted); font-size: 14px; margin-bottom: 8px; }
input {
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text);
  font-size: 15px;
  padding: 12px;
  width: 100%;
  text-align: center;
}
button {
  background: var(--color-accent);
  border: none;
  border-radius: 8px;
  color: var(--color-accent-text);
  cursor: pointer;
  font-size: 15px;
  font-weight: 600;
  padding: 12px;
  width: 100%;
  margin-top: 4px;
}
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.secondary { background: var(--color-surface-alt); color: var(--color-text); border: 1px solid var(--color-border); }
.error { color: var(--color-error); font-size: 13px; }
.error-detail { color: var(--color-text-muted); font-size: 11px; font-family: monospace; word-break: break-word; text-align: left; width: 100%; }
.success-hint { color: var(--color-success); font-size: 13px; }
.recovery-hint { margin-top: 16px; text-align: center; }
</style>
