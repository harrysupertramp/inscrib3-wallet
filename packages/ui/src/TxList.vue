<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useWalletClient } from './wallet-client-key.js';
import { useNetworkInfo, useAssets } from './composables/useWalletState.js';
import { getArkadeExplorerTxUrl, getMempoolTxUrl, type TxHistoryEntry } from '@inscrib3/core';
import Icon from './Icon.vue';

// Ark layers only: 'onchain' is Ark's boarding address - see
// TxHistoryEntry.layer.
const props = defineProps<{ type: 'send' | 'receive'; layer: 'ark' | 'onchain' }>();

type TxEntry = TxHistoryEntry;

const txs = ref<TxEntry[]>([]);
const loading = ref(true);
const error = ref('');

const { network, esploraUrl, refresh: refreshNetwork } = useNetworkInfo();
const { label: assetLabel, displayAmount: assetDisplayAmount, refresh: refreshAssets, ensureMetadata: ensureAssetMetadata } = useAssets();
const client = useWalletClient();

const filtered = computed(() =>
  txs.value.filter((tx) => tx.type === props.type && tx.layer === props.layer),
);

function sats(n: number): string {
  return Math.abs(n).toLocaleString();
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function shortTxid(txid: string): string {
  if (!txid) return '—';
  return `${txid.slice(0, 8)}…${txid.slice(-8)}`;
}

function explorerUrl(txid: string): string | null {
  if (!txid || !network.value) return null;
  return getArkadeExplorerTxUrl(network.value, txid);
}

function mempoolUrl(onchainTxid: string | undefined): string | null {
  if (!onchainTxid || !esploraUrl.value) return null;
  return getMempoolTxUrl(esploraUrl.value, onchainTxid);
}

// An asset's genesis tx is typed as a send, but the issuer gained the asset.
function assetDirection(isMint?: boolean): 'send' | 'receive' {
  return isMint ? 'receive' : props.type;
}

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    txs.value = await client.getTransactionHistory();
    const assetIds = txs.value.flatMap((tx) => tx.assets?.map((a) => a.assetId) ?? []);
    if (assetIds.length > 0) void ensureAssetMetadata(assetIds);
  } catch (e: unknown) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  refresh();
  refreshNetwork();
  refreshAssets();
});

defineExpose({ refresh });
</script>

<template>
  <div class="tx-list-wrap">
    <p class="section-title">{{ type === 'receive' ? 'Received on this address' : 'Sent from here' }}</p>
    <p v-if="loading" class="hint">Loading…</p>
    <p v-else-if="error" class="error">{{ error }}</p>
    <p v-else-if="filtered.length === 0" class="hint">
      {{ type === 'receive' ? 'Nothing received here yet' : 'Nothing sent here yet' }}
    </p>
    <div v-else class="tx-list">
      <div v-for="tx in filtered" :key="tx.txid + tx.timestamp" class="tx-row">
        <div class="tx-main">
          <span class="tx-amount" :class="type">{{ type === 'receive' ? '+' : '-' }}{{ sats(tx.amount) }} sats</span>
          <span class="tx-status" :class="tx.status">{{ tx.status }}</span>
        </div>
        <div v-if="tx.assets?.length" class="tx-assets">
          <span v-for="a in tx.assets" :key="a.assetId" class="tx-asset-chip" :class="assetDirection(a.isMint)">
            {{ assetDirection(a.isMint) === 'receive' ? '+' : '-' }}{{ assetDisplayAmount(a.assetId, a.amount) }} {{ assetLabel(a.assetId) }}
          </span>
        </div>
        <div class="tx-meta">
          <div class="tx-id-group">
            <a
              v-if="explorerUrl(tx.txid)"
              :href="explorerUrl(tx.txid)!"
              target="_blank"
              rel="noopener noreferrer"
              class="tx-id tx-id-link"
            >{{ shortTxid(tx.txid) }} ↗</a>
            <span v-else class="tx-id">{{ shortTxid(tx.txid) }}</span>
            <a
              v-if="mempoolUrl(tx.onchainTxid)"
              :href="mempoolUrl(tx.onchainTxid)!"
              target="_blank"
              rel="noopener noreferrer"
              class="tx-id-link mempool-link"
            >mempool ↗</a>
          </div>
          <span class="tx-date">{{ formatDate(tx.timestamp) }}</span>
        </div>
      </div>
    </div>

    <button type="button" class="refresh" @click="refresh" :disabled="loading">
      <Icon name="refresh" :size="14" />
      {{ loading ? 'Refreshing…' : 'Refresh' }}
    </button>
  </div>
</template>

<style scoped>
.tx-list-wrap { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
.section-title { font-size: 12px; color: var(--color-text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.hint, .error { color: var(--color-text-muted); font-size: 13px; }
.error { color: var(--color-error); }
.tx-list { display: flex; flex-direction: column; gap: 8px; }
.tx-row {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tx-main { display: flex; justify-content: space-between; align-items: center; }
.tx-amount { font-size: 13px; font-weight: 700; font-family: monospace; }
.tx-amount.receive { color: var(--color-success); }
.tx-amount.send { color: #ff9f6b; }
.tx-assets { display: flex; flex-wrap: wrap; gap: 6px; }
.tx-asset-chip {
  font-size: 10px;
  font-weight: 600;
  font-family: monospace;
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 2px 6px;
}
.tx-asset-chip.send { color: #ff9f6b; }
.tx-asset-chip.receive { color: var(--color-success); }
.tx-status { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 6px; border-radius: 4px; }
.tx-status.confirmed { background: #0d1f0d; color: var(--color-success); }
.tx-status.pending { background: #1f1a0d; color: #e0a030; }
.tx-meta { display: flex; justify-content: space-between; align-items: center; }
.tx-id-group { display: flex; align-items: center; gap: 8px; }
.tx-id { font-family: monospace; font-size: 11px; color: var(--color-text-muted); }
.tx-id-link { color: var(--color-accent-secondary); text-decoration: none; }
.tx-id-link:hover { text-decoration: underline; }
.mempool-link { font-size: 10px; }
.tx-date { font-size: 11px; color: #666; }
.refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 8px;
}
.refresh:disabled { opacity: 0.5; }
</style>
