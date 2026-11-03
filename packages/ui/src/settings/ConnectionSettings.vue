<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ConnectionInfo } from '@inscrib3/core';
import { useWalletClient } from '../wallet-client-key.js';

const client = useWalletClient();

const connection = ref<ConnectionInfo | null>(null);
const connectionLoading = ref(false);
const connectionError = ref('');

// Mounted only when this screen opens: it makes two network round trips.
async function loadConnection() {
  if (!client.getConnectionInfo) return;
  connectionLoading.value = true;
  connectionError.value = '';
  try {
    connection.value = await client.getConnectionInfo();
  } catch (e: unknown) {
    connectionError.value = String(e);
  } finally {
    connectionLoading.value = false;
  }
}

// arkd delays mean seconds at >= 512 and blocks below (same rule as the SDK's
// delayToTimelock).
function formatDelay(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (n < 512) return `${n} blocks (~${(n / 6).toFixed(1)} hours)`;
  const hours = n / 3600;
  return hours >= 24 ? `${n}s (~${(hours / 24).toFixed(1)} days)` : `${n}s (~${hours.toFixed(1)} hours)`;
}

function shortKey(value: string): string {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

onMounted(loadConnection);
</script>

<template>
  <section class="settings-view">
    <p class="hint">Every remote party this wallet talks to. Read-only - change servers under Network.</p>
    <p v-if="connectionLoading" class="hint">Loading…</p>
    <p v-else-if="connectionError" class="error">{{ connectionError }}</p>
    <template v-else-if="connection">
      <div class="conn-card">
        <div class="conn-head">
          <h3>Ark server</h3>
          <span class="badge" :class="connection.arkReachable ? 'ok' : 'down'">
            {{ connection.arkReachable ? 'Reachable' : 'Unreachable' }}
          </span>
        </div>
        <dl>
          <div><dt>URL</dt><dd class="mono">{{ connection.arkServerUrl }}</dd></div>
          <div><dt>Network</dt><dd>{{ connection.displayName }} ({{ connection.network }})</dd></div>
          <div v-if="connection.serverVersion"><dt>Version</dt><dd class="mono">{{ connection.serverVersion }}</dd></div>
          <div v-if="connection.signerPubkey"><dt>Signer key</dt><dd class="mono">{{ shortKey(connection.signerPubkey) }}</dd></div>
          <div v-if="connection.unilateralExitDelay"><dt>Exit delay</dt><dd>{{ formatDelay(connection.unilateralExitDelay) }}</dd></div>
          <div v-if="connection.boardingExitDelay"><dt>Boarding delay</dt><dd>{{ formatDelay(connection.boardingExitDelay) }}</dd></div>
        </dl>
      </div>

      <div class="conn-card">
        <div class="conn-head"><h3>Onchain explorer</h3></div>
        <dl>
          <div><dt>Esplora</dt><dd class="mono">{{ connection.esploraUrl }}</dd></div>
        </dl>
      </div>

      <div class="conn-card">
        <div class="conn-head">
          <h3>Delegator</h3>
          <span
            class="badge"
            :class="!connection.delegateUrl ? 'none' : connection.delegateReachable ? 'ok' : 'down'"
          >
            {{ !connection.delegateUrl ? 'None' : connection.delegateReachable ? 'Reachable' : 'Unreachable' }}
          </span>
        </div>
        <template v-if="connection.delegateUrl">
          <dl>
            <div><dt>URL</dt><dd class="mono">{{ connection.delegateUrl }}</dd></div>
            <div v-if="connection.delegatePubkey"><dt>Delegate key</dt><dd class="mono">{{ shortKey(connection.delegatePubkey) }}</dd></div>
            <div v-if="connection.delegateFeeSats"><dt>Fee</dt><dd>{{ connection.delegateFeeSats }} sats</dd></div>
            <div v-if="connection.delegateAddress"><dt>Its address</dt><dd class="mono">{{ shortKey(connection.delegateAddress) }}</dd></div>
          </dl>
          <p class="hint">
            Keeps your VTXOs renewing while the wallet is closed. It can only co-sign a renewal you pre-signed to your own address — it can never move funds anywhere else.
          </p>
          <p v-if="!connection.delegateReachable" class="hint warning">
            The delegator isn't answering. Your funds are safe, but renewals won't happen while the wallet is closed until it's back.
          </p>
        </template>
        <p v-else class="hint">
          This network has no delegation service, so VTXOs only renew while the wallet is open.
        </p>
      </div>

      <button type="button" class="secondary" @click="loadConnection" :disabled="connectionLoading">Refresh</button>
    </template>
  </section>
</template>

<style scoped>
.conn-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 12px;
}
.conn-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.conn-card h3 { font-size: 13px; font-weight: 600; color: var(--color-text); margin: 0; }
.conn-card dl { display: flex; flex-direction: column; gap: 6px; margin: 0; }
.conn-card dl > div { display: flex; align-items: baseline; gap: 10px; }
.conn-card dt { font-size: 12px; color: var(--color-text-muted); flex: 0 0 104px; }
.conn-card dd { font-size: 12px; color: var(--color-text); margin: 0; flex: 1 1 auto; min-width: 0; word-break: break-all; }
.conn-card dd.mono { font-family: monospace; }
.badge {
  border-radius: 999px;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
}
.badge.ok { background: rgba(60, 180, 120, 0.15); color: var(--color-success); }
.badge.down { background: rgba(224, 160, 48, 0.15); color: #e0a030; }
.badge.none { background: var(--color-surface-alt); color: var(--color-text-muted); }
</style>
