<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue';
import { useWalletClient } from './wallet-client-key.js';
import { useNetworkInfo, useAssets } from './composables/useWalletState.js';
import { getArkadeExplorerTxUrl, getMempoolTxUrl, type TxHistoryEntry } from '@inscrib3/core';
import Icon from './Icon.vue';
import ToggleGroup, { type ToggleOption } from './ToggleGroup.vue';

type TxEntry = TxHistoryEntry;

// Full list by default. Embedded in another screen (home) it drops the
// filters and its own Refresh.
const props = defineProps<{ limit?: number; embedded?: boolean }>();

type FilterLayer = 'all' | 'arkade' | 'lightning';

const FILTER_OPTIONS: ToggleOption<FilterLayer>[] = [
  { value: 'all', label: 'All' },
  { value: 'arkade', label: 'Arkade' },
  { value: 'lightning', label: 'Lightning' },
];

const txs = ref<TxEntry[]>([]);
const loading = ref(true);
const error = ref('');
const filter = ref<FilterLayer>('all');

// Arkade covers its offchain txs and its boarding address ('onchain').
const filteredTxs = computed(() => {
  let list = txs.value;
  if (filter.value === 'arkade') list = list.filter((tx) => tx.layer === 'ark' || tx.layer === 'onchain');
  else if (filter.value !== 'all') list = list.filter((tx) => tx.layer === filter.value);
  return props.limit ? list.slice(0, props.limit) : list;
});

const { network, esploraUrl, refresh: refreshNetwork } = useNetworkInfo();
const { label: assetLabel, displayAmount: assetDisplayAmount, refresh: refreshAssets, ensureMetadata: ensureAssetMetadata } = useAssets();
const client = useWalletClient();

function sats(n: number): string {
  return Math.abs(n).toLocaleString();
}

// An asset's genesis tx is typed as a send, but the issuer gained the asset.
function assetDirection(tx: TxEntry, isMint?: boolean): 'send' | 'receive' {
  return isMint ? 'receive' : tx.type;
}

function isMintTx(tx: TxEntry): boolean {
  return tx.assets?.some((a) => a.isMint) ?? false;
}

function rowDirection(tx: TxEntry): 'send' | 'receive' {
  return isMintTx(tx) ? 'receive' : tx.type;
}

function rowLabel(tx: TxEntry): string {
  if (isMintTx(tx)) return 'Created';
  return tx.type === 'send' ? 'Sent' : 'Received';
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function shortTxid(txid: string): string {
  if (!txid) return '—';
  return `${txid.slice(0, 8)}…${txid.slice(-8)}`;
}

function explorerUrl(tx: TxEntry): string | null {
  if (!tx.txid) return null;
  return network.value ? getArkadeExplorerTxUrl(network.value, tx.txid) : null;
}

function mempoolUrl(onchainTxid: string | undefined): string | null {
  if (!onchainTxid || !esploraUrl.value) return null;
  return getMempoolTxUrl(esploraUrl.value, onchainTxid);
}

// No push channel for preconfirmed -> settled, so poll quietly.
async function refresh(opts: { silent?: boolean } = {}) {
  if (!opts.silent) loading.value = true;
  if (!opts.silent) error.value = '';
  try {
    txs.value = await client.getTransactionHistory();
    const assetIds = txs.value.flatMap((tx) => tx.assets?.map((a) => a.assetId) ?? []);
    if (assetIds.length > 0) void ensureAssetMetadata(assetIds);
  } catch (e: unknown) {
    if (!opts.silent) error.value = String(e);
  } finally {
    if (!opts.silent) loading.value = false;
  }
}

const POLL_INTERVAL_MS = 20_000;
let pollHandle: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  refresh();
  refreshNetwork();
  refreshAssets();
  startPolling();
});

function startPolling() {
  stopPolling();
  pollHandle = setInterval(() => refresh({ silent: true }), POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}

// Inside the kept-alive home page: no polling while it's hidden; on return,
// refresh quietly and resume. Keyed on having been hidden, not on counting
// activations: whether onActivated fires at mount depends on how this was
// mounted.
let wasHidden = false;
onActivated(() => {
  if (!wasHidden) return;
  wasHidden = false;
  void refresh({ silent: true });
  startPolling();
});
onDeactivated(() => {
  wasHidden = true;
  stopPolling();
});
onUnmounted(stopPolling);
</script>

<template>
  <div class="activity">
    <ToggleGroup v-if="!embedded" variant="pill" :options="FILTER_OPTIONS" v-model="filter" />

    <p v-if="loading" class="hint">Loading activity…</p>
    <p v-else-if="error" class="error">{{ error }}</p>
    <p v-else-if="filteredTxs.length === 0" class="hint">
      {{ filter === 'all' ? 'No activity yet' : 'Nothing here yet' }}
    </p>
    <div v-else class="tx-list">
      <div v-for="tx in filteredTxs" :key="tx.txid + tx.timestamp" class="tx-row">
        <div class="tx-main">
          <span class="tx-type" :class="rowDirection(tx)">
            <Icon :name="rowDirection(tx) === 'send' ? 'arrow-up' : 'arrow-down'" :size="14" />
            {{ rowLabel(tx) }}
          </span>
          <span class="tx-amount" :class="rowDirection(tx)">{{ rowDirection(tx) === 'send' ? '-' : '+' }}{{ sats(tx.amount) }} sats</span>
        </div>
        <div v-if="tx.assets?.length" class="tx-assets">
          <span v-for="a in tx.assets" :key="a.assetId" class="tx-asset-chip" :class="assetDirection(tx, a.isMint)">
            {{ assetDirection(tx, a.isMint) === 'send' ? '-' : '+' }}{{ assetDisplayAmount(a.assetId, a.amount) }} {{ assetLabel(a.assetId) }}
          </span>
        </div>
        <div class="tx-meta">
          <div class="tx-id-group">
            <a
              v-if="explorerUrl(tx)"
              :href="explorerUrl(tx)!"
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
          <span class="tx-status" :class="tx.status">{{ tx.status }}</span>
        </div>
        <div class="tx-date">{{ formatDate(tx.timestamp) }}</div>
      </div>
    </div>

    <button v-if="!embedded" class="refresh" @click="refresh()" :disabled="loading">
      <Icon name="refresh" :size="14" />
      {{ loading ? 'Refreshing…' : 'Refresh' }}
    </button>
  </div>
</template>

<style scoped>
.activity { display: flex; flex-direction: column; gap: 12px; }
.hint, .error { color: var(--color-text-muted); font-size: 14px; padding: 20px 0; text-align: center; }
.error { color: var(--color-error); }
.tx-list { display: flex; flex-direction: column; gap: 8px; }
.tx-row {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tx-main { display: flex; justify-content: space-between; align-items: center; }
.tx-type { display: flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; color: var(--color-text-muted); }
.tx-type.send { color: #ff9f6b; }
.tx-type.receive { color: var(--color-success); }
.tx-amount { font-size: 14px; font-weight: 700; font-family: monospace; }
.tx-amount.send { color: #ff9f6b; }
.tx-amount.receive { color: var(--color-success); }
.tx-assets { display: flex; flex-wrap: wrap; gap: 6px; }
.tx-asset-chip {
  font-size: 11px;
  font-weight: 600;
  font-family: monospace;
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 2px 6px;
}
.tx-asset-chip.send { color: #ff9f6b; }
.tx-asset-chip.receive { color: var(--color-success); }
.tx-meta { display: flex; justify-content: space-between; align-items: center; }
.tx-id-group { display: flex; align-items: center; gap: 8px; }
.tx-id { font-family: monospace; font-size: 11px; color: var(--color-text-muted); }
.tx-id-link { color: var(--color-accent-secondary); text-decoration: none; }
.tx-id-link:hover { text-decoration: underline; }
.mempool-link { font-size: 10px; }
.tx-status { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 6px; border-radius: 4px; }
.tx-status.confirmed { background: #0d1f0d; color: var(--color-success); }
.tx-status.pending { background: #1f1a0d; color: #e0a030; }
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
  font-size: 13px;
  padding: 8px;
}
.refresh:disabled { opacity: 0.5; }
</style>
