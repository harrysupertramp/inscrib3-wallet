<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useWalletClient } from './wallet-client-key.js';
import BalanceView from './BalanceView.vue';
import SendView from './SendView.vue';
import ReceiveView from './ReceiveView.vue';
import SettingsPanel from './SettingsPanel.vue';
import Activity from './Activity.vue';
import Assets from './Assets.vue';
import Icon from './Icon.vue';
import type { IncomingFundsSummary } from '@inscrib3/core';

const emit = defineEmits<{ locked: [] }>();

type Section = 'home' | 'activity' | 'settings';
// Home's sub-screens, each opened from the home page and closed with Back.
// A send's asset is SendView's key: 'btc' or 'ark:<assetId>'.
type Screen =
  | { kind: 'home' }
  | { kind: 'send'; asset: string }
  | { kind: 'receive' }
  | { kind: 'ark-asset'; assetId: string };

const section = ref<Section>('home');
const screen = ref<Screen>({ kind: 'home' });

function goHome() {
  section.value = 'home';
  screen.value = { kind: 'home' };
}

function openSend(asset: string) {
  screen.value = { kind: 'send', asset };
}

const client = useWalletClient();

// Bumped when funds land to remount the read-only views. Not applied to the
// send forms: incoming funds must not wipe a half-filled send.
const dataKey = ref(0);
const received = ref<IncomingFundsSummary | null>(null);
let receivedTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: (() => void) | undefined;

onMounted(() => {
  unsubscribe = client.onEvent((event, data) => {
    if (event !== 'fundsReceived') return;
    dataKey.value++;
    received.value = data as IncomingFundsSummary;
    clearTimeout(receivedTimer);
    receivedTimer = setTimeout(() => {
      received.value = null;
    }, 6000);
  });
});

onUnmounted(() => {
  unsubscribe?.();
  clearTimeout(receivedTimer);
});

async function lock() {
  await client.lock();
  emit('locked');
}
</script>

<template>
  <div class="dashboard">
    <header>
      <span class="logo"><img src="/image/inscrib3_logo.png" alt="Inscrib3" /></span>
      <button class="icon-btn" @click="lock" title="Lock wallet"><Icon name="lock" :size="18" /></button>
    </header>

    <p v-if="received" class="funds-toast">
      Received {{ received.amountSats.toLocaleString() }} sats
      <span class="funds-layer">{{ received.type === 'vtxo' ? 'offchain' : 'onchain' }}</span>
    </p>

    <div class="body">
      <div class="content">
        <!-- Kept alive while another screen is open, so coming back shows the
             last data at once and refreshes it in the background. -->
        <KeepAlive :max="1">
          <BalanceView
            v-if="section === 'home' && screen.kind === 'home'"
            :key="dataKey"
            @send="openSend('btc')"
            @receive="screen = { kind: 'receive' }"
            @open-asset="(assetId) => (screen = { kind: 'ark-asset', assetId })"
            @see-all-activity="section = 'activity'"
          />
        </KeepAlive>

        <template v-if="section === 'home'">
          <div v-if="screen.kind === 'send'" class="screen">
            <button type="button" class="back" @click="goHome"><Icon name="arrow-left" :size="14" /> Back</button>
            <h2>Send</h2>
            <SendView :initial-asset="screen.asset" />
          </div>

          <div v-else-if="screen.kind === 'receive'" class="screen">
            <button type="button" class="back" @click="goHome"><Icon name="arrow-left" :size="14" /> Back</button>
            <h2>Receive</h2>
            <ReceiveView :refresh-key="dataKey" />
          </div>

          <Assets
            v-else-if="screen.kind === 'ark-asset'"
            :key="dataKey"
            :asset-id="screen.assetId"
            @back="goHome"
            @send="openSend(`ark:${screen.assetId}`)"
          />
        </template>

        <div v-else-if="section === 'activity'" class="screen">
          <h2>Activity</h2>
          <Activity :key="dataKey" />
        </div>

        <SettingsPanel v-else-if="section === 'settings'" />
      </div>
    </div>

    <nav class="bottom-nav">
      <button :class="{ active: section === 'home' }" @click="goHome">
        <Icon name="home" :size="20" />
        Home
      </button>
      <button :class="{ active: section === 'activity' }" @click="section = 'activity'">
        <Icon name="clock" :size="20" />
        Activity
      </button>
      <button :class="{ active: section === 'settings' }" @click="section = 'settings'">
        <Icon name="settings" :size="20" />
        Settings
      </button>
    </nav>
  </div>
</template>

<style scoped>
.funds-toast {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(60, 180, 120, 0.12);
  border: 1px solid var(--color-success);
  border-radius: 8px;
  color: var(--color-success);
  font-size: 13px;
  font-weight: 600;
  margin: 0 12px 8px;
  padding: 8px 12px;
}
.funds-layer { color: var(--color-text-muted); font-size: 11px; font-weight: 500; text-transform: uppercase; }
.dashboard { display: flex; flex-direction: column; min-height: 100vh; }
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}
.logo { display: flex; align-items: center; gap: 6px; font-size: 15px; font-weight: 700; }
.logo img { width: 16px; height: 19px; object-fit: contain; }
.icon-btn { background: none; border: none; cursor: pointer; color: var(--color-text); display: flex; align-items: center; }
.body { flex: 1; display: flex; flex-direction: column; overflow-y: auto; }
.content { flex: 1; padding: 20px; overflow-y: auto; }
.screen { display: flex; flex-direction: column; gap: 12px; }
.screen h2 { font-size: 16px; font-weight: 700; }
.back { display: flex; align-items: center; gap: 4px; background: none; border: none; color: var(--color-text-muted); cursor: pointer; font-size: 13px; padding: 0; text-align: left; }
.bottom-nav {
  display: flex;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg);
}
.bottom-nav button {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  padding: 10px 0 12px;
}
.bottom-nav button.active { color: var(--color-accent); }
</style>
