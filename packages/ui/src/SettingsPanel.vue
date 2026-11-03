<script setup lang="ts">
import { computed, ref } from 'vue';
import { useWalletClient } from './wallet-client-key.js';
import Icon from './Icon.vue';
import RecoveryPanel from './RecoveryPanel.vue';
import ConnectionSettings from './settings/ConnectionSettings.vue';
import NetworkSettings from './settings/NetworkSettings.vue';
import AccountsSettings from './settings/AccountsSettings.vue';
import SeedSettings from './settings/SeedSettings.vue';
import SitesSettings from './settings/SitesSettings.vue';
import AdvancedSettings from './settings/AdvancedSettings.vue';

const client = useWalletClient();

type SettingsView =
  | 'menu'
  | 'connection'
  | 'network'
  | 'accounts'
  | 'seed'
  | 'sites'
  | 'recovery'
  | 'advanced';

interface MenuItem {
  id: Exclude<SettingsView, 'menu'>;
  title: string;
  subtitle: string;
  icon: string;
}

const view = ref<SettingsView>('menu');

const MENU: MenuItem[] = [
  { id: 'connection', title: 'Connection', subtitle: 'Which Ark server and delegator this wallet uses', icon: 'server' },
  { id: 'network', title: 'Network', subtitle: 'Switch network, or point at your own server', icon: 'globe' },
  { id: 'accounts', title: 'Accounts', subtitle: 'Add, rename, switch or import accounts', icon: 'users' },
  { id: 'seed', title: 'Seed phrase', subtitle: 'Reveal and back up your recovery words', icon: 'key' },
  { id: 'sites', title: 'Connected sites', subtitle: 'Review and revoke sites you approved', icon: 'link' },
  { id: 'recovery', title: 'Recovery', subtitle: 'Unilateral exit - move funds onchain alone', icon: 'shield' },
  { id: 'advanced', title: 'Advanced', subtitle: 'Reset the local cache and re-sync', icon: 'alert-triangle' },
];

// Rows backed by optional WalletClient methods are hidden when absent.
const menuItems = computed(() =>
  MENU.filter((item) => {
    if (item.id === 'connection') return Boolean(client.getConnectionInfo);
    if (item.id === 'sites') return Boolean(client.getConnectedOrigins);
    if (item.id === 'advanced') return Boolean(client.resetLocalCache);
    return true;
  }),
);

const currentTitle = computed(() => MENU.find((m) => m.id === view.value)?.title ?? '');
</script>

<template>
  <div class="settings">
    <div v-if="view === 'menu'" class="menu">
      <button
        v-for="item in menuItems"
        :key="item.id"
        type="button"
        class="menu-row"
        @click="view = item.id"
      >
        <span class="menu-icon"><Icon :name="item.icon" :size="18" /></span>
        <span class="menu-text">
          <span class="menu-title">{{ item.title }}</span>
          <span class="menu-sub">{{ item.subtitle }}</span>
        </span>
        <Icon name="chevron-right" :size="16" class="menu-chevron" />
      </button>
    </div>

    <template v-else>
      <div class="detail-header">
        <button type="button" class="back-btn" @click="view = 'menu'" aria-label="Back to settings">
          <Icon name="arrow-left" :size="16" />
        </button>
        <h2>{{ currentTitle }}</h2>
      </div>

      <ConnectionSettings v-if="view === 'connection'" />
      <NetworkSettings v-else-if="view === 'network'" />
      <AccountsSettings v-else-if="view === 'accounts'" />
      <SeedSettings v-else-if="view === 'seed'" />
      <SitesSettings v-else-if="view === 'sites'" />
      <AdvancedSettings v-else-if="view === 'advanced'" />
      <RecoveryPanel v-else-if="view === 'recovery'" />
    </template>
  </div>
</template>

<style src="./settings/settings-view.css"></style>

<style scoped>
.settings { display: flex; flex-direction: column; gap: 28px; }
section { display: flex; flex-direction: column; gap: 10px; }
h2 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #ccc; }

.menu { display: flex; flex-direction: column; gap: 8px; }
.menu-row {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  color: var(--color-text);
  cursor: pointer;
  padding: 12px;
  text-align: left;
  width: 100%;
}
.menu-row:hover { border-color: var(--color-accent); }
.menu-icon { display: flex; color: var(--color-accent-secondary); flex-shrink: 0; }
/* lets the subtitle ellipsize inside the 360px popup */
.menu-text { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.menu-title { font-size: 14px; font-weight: 600; }
.menu-sub { font-size: 12px; color: var(--color-text-muted); line-height: 1.4; }
.menu-chevron { color: var(--color-text-muted); flex-shrink: 0; }

.detail-header { display: flex; align-items: center; gap: 10px; }
.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text);
  cursor: pointer;
  flex-shrink: 0;
  padding: 6px;
  width: auto;
}
.detail-header h2 { margin: 0; }
button {
  background: var(--color-accent);
  border: none;
  border-radius: 8px;
  color: var(--color-accent-text);
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  padding: 10px;
  width: 100%;
}
button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
