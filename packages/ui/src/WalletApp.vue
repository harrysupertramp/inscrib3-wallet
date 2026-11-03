<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import UnlockScreen from './UnlockScreen.vue';
import SetupScreen from './SetupScreen.vue';
import Dashboard from './Dashboard.vue';
import { useWalletClient } from './wallet-client-key.js';

type Screen = 'loading' | 'error' | 'setup' | 'unlock' | 'dashboard';

const screen = ref<Screen>('loading');
const client = useWalletClient();
// Dashboard's :key - remounts every view on an account switch so nothing
// stale from the previous account survives.
const dashboardKey = ref(0);

async function refreshScreen() {
  try {
    const isCreated = await client.isCreated();
    const isUnlocked = await client.isUnlocked();

    if (!isCreated) {
      screen.value = 'setup';
    } else if (!isUnlocked) {
      screen.value = 'unlock';
    } else {
      screen.value = 'dashboard';
    }
  } catch {
    // Never fall back to setup: creating a wallet there would look like the
    // way out, while the real one still exists.
    screen.value = 'error';
  }
}

// The wallet can lock on its own (auto-lock, network change).
let unsubscribe: (() => void) | null = null;

function onWalletEvent(event: string) {
  if (event === 'lock') {
    screen.value = 'unlock';
  } else if (event === 'unlock') {
    void refreshScreen();
  } else if (event === 'accountChanged' || event === 'networkChanged') {
    dashboardKey.value++;
  }
}

onMounted(() => {
  refreshScreen();
  unsubscribe = client.onEvent(onWalletEvent);
});

onUnmounted(() => {
  unsubscribe?.();
});

function onSetupComplete() { screen.value = 'dashboard'; }
function onUnlocked() { screen.value = 'dashboard'; }
function onLocked() { screen.value = 'unlock'; }
</script>

<template>
  <div v-if="screen === 'loading'" class="loading">Loading...</div>
  <div v-else-if="screen === 'error'" class="loading">
    <p>Couldn't read the wallet's state.</p>
    <button type="button" @click="refreshScreen">Retry</button>
  </div>
  <SetupScreen v-else-if="screen === 'setup'" @complete="onSetupComplete" />
  <UnlockScreen v-else-if="screen === 'unlock'" @unlocked="onUnlocked" />
  <Dashboard v-else :key="dashboardKey" @locked="onLocked" />
</template>

<style scoped>
.loading {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 12px;
  justify-content: center;
  height: 100vh;
  color: #888;
  font-size: 14px;
}
</style>
