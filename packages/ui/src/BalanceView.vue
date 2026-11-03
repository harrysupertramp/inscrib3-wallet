<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue';
import { useWalletBalance, useBtcPrice, useNetworkInfo, useWalletAddresses } from './composables/useWalletState.js';
import { useWalletClient } from './wallet-client-key.js';
import {
  getArkadeExplorerTxUrl,
  getMempoolTxUrl,
  SettlementEventType,
  type SerializableVtxo,
  type AssetEntry,
  type SettleProgressEvent,
  type SerializableSettleProgress,
} from '@inscrib3/core';
import Icon from './Icon.vue';
import Activity from './Activity.vue';
import { formatAssetAmount } from './format.js';

// The home screen: the total, the Arkade wallet (offchain + 2-of-2 boarding
// address), then the latest activity.

function sats(n: number): string {
  return n.toLocaleString();
}

function btc(n: number): string {
  return (n / 1e8).toFixed(8);
}

function usd(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function tickerOrShortId(asset: AssetEntry): string {
  return asset.metadata?.ticker ?? `${asset.assetId.slice(0, 8)}…`;
}

function shortTxid(txid: string): string {
  if (!txid) return '—';
  return `${txid.slice(0, 8)}…${txid.slice(-8)}`;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function shortAddress(addr: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '';
}

const { balance, loading, error, refresh } = useWalletBalance();
const { address: arkAddress, refresh: refreshArkAddress } = useWalletAddresses();
const { usdPrice, refresh: refreshPrice } = useBtcPrice();
const { network, esploraUrl, refresh: refreshNetwork } = useNetworkInfo();
const client = useWalletClient();

function vtxoExplorerUrl(txid: string): string | null {
  if (!txid || !network.value) return null;
  return getArkadeExplorerTxUrl(network.value, txid);
}

function vtxoMempoolUrl(settledTxid: string | undefined): string | null {
  if (!settledTxid || !esploraUrl.value) return null;
  return getMempoolTxUrl(esploraUrl.value, settledTxid);
}

// getBalance() carries no ticker/decimals.
const assets = ref<AssetEntry[]>([]);
async function refreshAssets() {
  try {
    assets.value = await client.getAssets();
  } catch {
    // keep the last list: a failed background refresh shouldn't hide assets
  }
}

const emit = defineEmits<{
  'open-asset': [assetId: string];
  send: [];
  receive: [];
  'see-all-activity': [];
}>();

const showVtxos = ref(false);
const vtxos = ref<SerializableVtxo[]>([]);
const vtxosLoading = ref(false);
async function refreshVtxos() {
  vtxosLoading.value = true;
  try {
    vtxos.value = await client.getVtxos();
  } catch {
    // keep the last list: a failed background refresh shouldn't empty it
  } finally {
    vtxosLoading.value = false;
  }
}

// Bumped by Refresh to remount the embedded recent-activity list.
const activityKey = ref(0);

function refreshAll() {
  refresh();
  refreshPrice();
  refreshAssets();
  refreshVtxos();
  activityKey.value++;
}

const hasPreconfirmed = computed(() => vtxos.value.some((v) => v.status === 'preconfirmed'));

// The SDK renews coins this close to expiry on its own (SettlementConfig.vtxoThreshold),
// but only while the wallet is unlocked; past expiry the server may sweep them.
const RENEW_WINDOW_S = 3 * 24 * 60 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const expiringSoon = computed(() =>
  vtxos.value.filter((v) => !v.swept && v.expiresAt !== undefined && v.expiresAt - nowSeconds() < RENEW_WINDOW_S),
);
const sweptCount = computed(() => vtxos.value.filter((v) => v.swept).length);
const needsRenewal = computed(() => expiringSoon.value.length > 0 || sweptCount.value > 0);
const firstExpiry = computed(() => Math.min(...expiringSoon.value.map((v) => v.expiresAt!)));

function renewNow() {
  showVtxos.value = true;
  void settleNow();
}

const settling = ref(false);
const settleError = ref('');
const settleTxid = ref('');
const settleLog = ref<SettleProgressEvent[]>([]);

function settleEventLabel(event: SettleProgressEvent): string {
  switch (event.type) {
    case SettlementEventType.BatchStarted: return 'Batch round started…';
    case SettlementEventType.TreeSigningStarted: return 'Signing settlement tree…';
    case SettlementEventType.TreeNonces: return 'Exchanging signing nonces…';
    case SettlementEventType.TreeTx: return 'Building settlement tree…';
    case SettlementEventType.TreeSignature: return 'Collecting signatures…';
    case SettlementEventType.BatchFinalization: return 'Finalizing batch…';
    case SettlementEventType.BatchFinalized: return 'Batch finalized';
    case SettlementEventType.BatchFailed: return `Failed: ${event.reason}`;
    case SettlementEventType.StreamStarted: return 'Connected to settlement stream…';
    default: return 'Settling…'; // exhaustive above - unreachable, but keeps this a total function
  }
}

function describeSettleError(msg: string): string {
  if (msg.includes('BLOCKED_BY_EXPIRING_VTXO')) {
    return `Can't settle right now — settling bundles in ALL your VTXOs, and the server rejected one of them, usually because it is too close to its own expiry. This doesn't affect your balance; try again later. Server said: ${msg.replace(/^.*BLOCKED_BY_EXPIRING_VTXO:\s*/, '')}`;
  }
  if (msg.includes('INVALID_INTENT_PROOF')) {
    return `Nothing moved: the server no longer had this request on file. Try again. Server said: ${msg.replace(/^.*?INVALID_INTENT_PROOF:\s*/, '')}`;
  }
  return msg;
}

const SETTLE_POLL_INTERVAL_MS = 1_500;
let settlePollHandle: ReturnType<typeof setInterval> | null = null;

function stopSettlePolling() {
  if (settlePollHandle) {
    clearInterval(settlePollHandle);
    settlePollHandle = null;
  }
}

function startSettlePolling(onDone?: (progress: SerializableSettleProgress) => void) {
  stopSettlePolling();
  settlePollHandle = setInterval(async () => {
    try {
      const progress = await client.getSettleProgress();
      settleLog.value = progress.events;
      if (progress.done && onDone) {
        stopSettlePolling();
        onDone(progress);
      }
    } catch {
      // transient poll error - retry next tick
    }
  }, SETTLE_POLL_INTERVAL_MS);
}

async function settleNow() {
  settleError.value = '';
  settleTxid.value = '';
  settleLog.value = [];
  settling.value = true;
  startSettlePolling();
  try {
    settleTxid.value = await client.settle();
    await Promise.all([refresh(), refreshVtxos()]);
  } catch (e: unknown) {
    settleError.value = describeSettleError(String(e));
  } finally {
    stopSettlePolling();
    settling.value = false;
  }
}

// Reopening the popup mid-settle: the settle keeps running in the background,
// so poll its progress until done.
async function resumeSettleIfInProgress() {
  let inProgress: boolean;
  try {
    inProgress = await client.isSettling();
  } catch {
    return;
  }
  if (!inProgress) return;

  settleError.value = '';
  settleTxid.value = '';
  settleLog.value = [];
  settling.value = true;
  startSettlePolling((progress) => {
    settling.value = false;
    if (progress.txid) {
      settleTxid.value = progress.txid;
      void Promise.all([refresh(), refreshVtxos()]);
    } else if (progress.error) {
      settleError.value = describeSettleError(progress.error);
    }
  });
}

onUnmounted(stopSettlePolling);

const totalSats = computed(() => balance.value?.total ?? 0);

const totalUsd = computed(() => {
  if (!balance.value || usdPrice.value === null) return null;
  return (totalSats.value / 1e8) * usdPrice.value;
});

onMounted(() => {
  refresh();
  refreshArkAddress();
  refreshPrice();
  refreshAssets();
  refreshNetwork();
  refreshVtxos();
  resumeSettleIfInProgress();
});

// Kept alive by Dashboard: returning shows the last data at once and refreshes
// it in the background (only after having been hidden, not at mount).
let wasHidden = false;
onDeactivated(() => (wasHidden = true));
onActivated(() => {
  if (!wasHidden) return;
  wasHidden = false;
  refresh();
  refreshPrice();
  refreshAssets();
  refreshVtxos();
});
</script>

<template>
  <div class="balance-view">
    <!-- Only the first load blanks the page; later refreshes keep showing the
         last balance. -->
    <p v-if="loading && !balance" class="hint">Fetching balance…</p>
    <p v-else-if="error && !balance" class="error">{{ error }}</p>
    <template v-else-if="balance">
      <p v-if="error" class="error">Couldn't refresh: {{ error }}</p>
      <div class="hero">
        <div class="total">
          <span class="amount">{{ btc(totalSats) }}</span>
          <span class="unit">BTC</span>
        </div>
        <p class="sats">{{ sats(totalSats) }} sats<template v-if="totalUsd !== null"> · <span class="usd">${{ usd(totalUsd) }}</span></template></p>
      </div>

      <div class="actions">
        <button type="button" class="action-btn" @click="emit('receive')"><Icon name="arrow-down" :size="16" /> Receive</button>
        <button type="button" class="action-btn" @click="emit('send')"><Icon name="arrow-up" :size="16" /> Send</button>
      </div>

      <div class="wallet-header">
        <span class="section-title">Arkade</span>
        <span class="wallet-tag">2-of-2 · {{ shortAddress(arkAddress) }}</span>
      </div>

      <div class="breakdown">
        <div class="row">
          <span>Available (offchain)</span>
          <span>{{ sats(balance.available) }} sats</span>
        </div>
        <div class="row">
          <span>Settled</span>
          <span>{{ sats(balance.settled) }} sats</span>
        </div>
        <div class="row">
          <span>Boarding (onchain)</span>
          <span>{{ sats(balance.boarding.total) }} sats</span>
        </div>
      </div>

      <div v-if="assets.length > 0" class="assets-summary">
        <p class="section-title">Ark Assets</p>
        <button type="button" class="asset-row clickable" v-for="asset in assets" :key="asset.assetId" @click="emit('open-asset', asset.assetId)">
          <span>{{ asset.metadata?.name ?? tickerOrShortId(asset) }}</span>
          <span class="asset-amount">{{ formatAssetAmount(asset) }} {{ tickerOrShortId(asset) }} <Icon name="chevron-right" :size="12" /></span>
        </button>
      </div>

      <div v-if="needsRenewal && !settling" class="renew-banner">
        <p v-if="sweptCount > 0">
          {{ sweptCount }} VTXO{{ sweptCount === 1 ? ' has' : 's have' }} expired and been swept by the server. {{ sweptCount === 1 ? 'It is still yours: renewing recovers it.' : 'They are still yours: renewing recovers them.' }}
        </p>
        <p v-if="expiringSoon.length > 0">
          {{ expiringSoon.length }} VTXO{{ expiringSoon.length === 1 ? '' : 's' }} expire{{ expiringSoon.length === 1 ? 's' : '' }} by {{ formatDate(firstExpiry) }}.
          The wallet renews {{ expiringSoon.length === 1 ? 'it' : 'them' }} on its own while it's unlocked; renew now to be sure.
        </p>
        <button type="button" class="settle-btn" :disabled="settling" @click="renewNow">Renew now</button>
      </div>

      <div class="vtxo-section">
        <button type="button" class="vtxo-toggle" @click="showVtxos = !showVtxos">
          <span class="section-title">VTXOs{{ vtxos.length > 0 ? ` (${vtxos.length})` : '' }}</span>
          <Icon :name="showVtxos ? 'arrow-up' : 'arrow-down'" :size="14" />
        </button>
        <div v-if="showVtxos" class="vtxo-list">
          <p v-if="vtxosLoading && vtxos.length === 0" class="hint">Loading…</p>
          <p v-else-if="vtxos.length === 0" class="hint">No VTXOs</p>
          <template v-else>
            <div class="vtxo-row" v-for="v in vtxos" :key="v.txid + ':' + v.vout">
              <div class="vtxo-main">
                <span class="vtxo-amount">{{ sats(v.value) }} sats</span>
                <span class="vtxo-status" :class="v.status">{{ v.status }}</span>
              </div>
              <div class="vtxo-meta">
                <div class="vtxo-id-group">
                  <a
                    v-if="vtxoExplorerUrl(v.txid)"
                    :href="vtxoExplorerUrl(v.txid)!"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="vtxo-id vtxo-id-link"
                  >{{ shortTxid(v.txid) }}:{{ v.vout }} ↗</a>
                  <span v-else class="vtxo-id">{{ shortTxid(v.txid) }}:{{ v.vout }}</span>
                  <a
                    v-if="vtxoMempoolUrl(v.settledTxid)"
                    :href="vtxoMempoolUrl(v.settledTxid)!"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="vtxo-id-link mempool-link"
                  >mempool ↗</a>
                </div>
                <span class="vtxo-date">{{ formatDate(v.createdAt) }}</span>
              </div>
              <p v-if="v.assetIds.length > 0" class="vtxo-note">Carries {{ v.assetIds.length }} Ark asset{{ v.assetIds.length === 1 ? '' : 's' }}</p>
              <p v-if="v.swept" class="vtxo-note warning">Expired and swept - renew to recover it</p>
              <p v-else-if="v.expiresAt" class="vtxo-note" :class="{ warning: v.expiresAt - nowSeconds() < RENEW_WINDOW_S }">
                Expires {{ formatDate(v.expiresAt) }}
              </p>
            </div>
          </template>

          <div v-if="hasPreconfirmed || needsRenewal" class="vtxo-settle">
            <p v-if="settleError" class="error">{{ settleError }}</p>
            <div v-if="settleTxid" class="success">
              <p>Settled!</p>
              <p class="txid">{{ settleTxid }}</p>
              <a v-if="vtxoExplorerUrl(settleTxid)" :href="vtxoExplorerUrl(settleTxid)!" target="_blank" rel="noopener noreferrer" class="explorer-link">
                View on Arkade Explorer ↗
              </a>
              <!-- A settle produces a real Bitcoin (commitment) transaction. -->
              <a v-if="vtxoMempoolUrl(settleTxid)" :href="vtxoMempoolUrl(settleTxid)!" target="_blank" rel="noopener noreferrer" class="explorer-link">
                View on mempool ↗
              </a>
            </div>
            <!-- While renewal is needed the banner above holds the only button;
                 during a run the banner hides and this one shows progress. -->
            <button v-if="!needsRenewal || settling" type="button" class="settle-btn" @click="settleNow" :disabled="settling">
              {{ settling ? 'Settling…' : 'Settle now' }}
            </button>
            <div v-if="settling && settleLog.length > 0" class="log">
              <div class="log-row" v-for="(event, i) in settleLog" :key="i">
                <span>{{ settleEventLabel(event) }}</span>
              </div>
            </div>
            <p class="vtxo-note">Moves your VTXOs into a new batch: preconfirmed ones become settled, and expiring or swept ones are renewed. Broadcasts a real transaction.</p>
          </div>
        </div>
      </div>

      <div class="wallet-header">
        <span class="section-title">Recent activity</span>
        <button type="button" class="setup-link" @click="emit('see-all-activity')">See all →</button>
      </div>
      <Activity :key="activityKey" :limit="3" embedded />
    </template>
    <p v-else class="hint">No balance data</p>

    <button class="refresh" @click="refreshAll" :disabled="loading">
      <Icon name="refresh" :size="14" />
      {{ loading ? 'Refreshing…' : 'Refresh' }}
    </button>
  </div>
</template>

<style scoped>
.balance-view { display: flex; flex-direction: column; gap: 12px; }
.hero { display: flex; flex-direction: column; align-items: center; gap: 4px; margin-top: 4px; }
.total { display: flex; align-items: baseline; gap: 6px; }
.amount { font-size: 30px; font-weight: 700; font-family: monospace; }
.unit { font-size: 16px; color: var(--color-text-muted); }
.sats { color: var(--color-text-muted); font-size: 13px; }
.usd { color: var(--color-accent); font-weight: 600; }
.actions { display: flex; gap: 8px; }
.action-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--color-accent);
  border: none;
  border-radius: 8px;
  color: var(--color-accent-text);
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  padding: 10px;
}
.wallet-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border);
}
.wallet-header .section-title { font-size: 12px; }
.wallet-tag { font-size: 11px; font-family: monospace; color: var(--color-text-muted); }
.breakdown {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.row { display: flex; justify-content: space-between; font-size: 13px; color: #aaa; }
.assets-summary {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.section-title { font-size: 11px; color: var(--color-accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.asset-row { display: flex; justify-content: space-between; font-size: 13px; color: #aaa; }
.asset-row.clickable { background: none; border: none; cursor: pointer; padding: 0; text-align: left; width: 100%; }
.asset-row.clickable:hover .asset-amount { color: var(--color-accent); }
.asset-amount { display: flex; align-items: center; gap: 4px; font-family: monospace; color: var(--color-text); }
.setup-link {
  background: none;
  border: none;
  color: var(--color-accent-secondary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  padding: 0;
}
.setup-link:hover { text-decoration: underline; }
.vtxo-section {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  margin-top: 8px;
  overflow: hidden;
}
.vtxo-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 12px;
}
.vtxo-list { display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; }
.vtxo-row {
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.vtxo-main { display: flex; justify-content: space-between; align-items: center; }
.vtxo-amount { font-size: 13px; font-weight: 700; font-family: monospace; color: var(--color-text); }
.vtxo-status { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 6px; border-radius: 4px; }
.vtxo-status.settled { background: #0d1f0d; color: #4caf50; }
.vtxo-status.preconfirmed { background: #1f1a0d; color: #e0a030; }
.vtxo-meta { display: flex; justify-content: space-between; align-items: center; }
.vtxo-id-group { display: flex; align-items: center; gap: 8px; }
.vtxo-id { font-family: monospace; font-size: 11px; color: #888; }
.vtxo-id-link { color: var(--color-accent-secondary); text-decoration: none; }
.vtxo-id-link:hover { text-decoration: underline; }
.mempool-link { font-size: 10px; }
.vtxo-date { font-size: 11px; color: #666; }
.vtxo-note { font-size: 11px; color: var(--color-text-muted); }
.vtxo-note.warning { color: #ff8a80; }
.renew-banner {
  border: 1px solid #5c2a2a;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.vtxo-settle {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  margin-top: 4px;
  border-top: 1px solid var(--color-border);
}
.settle-btn {
  background: var(--color-accent);
  border: none;
  border-radius: 8px;
  color: var(--color-accent-text);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  padding: 10px;
  width: 100%;
}
.settle-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.log { display: flex; flex-direction: column; gap: 6px; }
.log-row {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  color: #ccc;
}
.success {
  background: #0d1f0d;
  border: 1px solid #2a5c2a;
  border-radius: 8px;
  padding: 10px;
  font-size: 12px;
  color: var(--color-success);
}
.txid {
  font-family: monospace;
  font-size: 11px;
  color: var(--color-text-muted);
  word-break: break-all;
  margin-top: 4px;
}
.explorer-link {
  display: inline-block;
  margin-top: 6px;
  color: var(--color-accent-secondary);
  font-size: 11px;
  font-weight: 600;
  text-decoration: none;
}
.explorer-link:hover { text-decoration: underline; }
.hint, .error { color: var(--color-text-muted); font-size: 14px; }
.error { color: var(--color-error); }
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
  margin-top: 8px;
}
.refresh:disabled { opacity: 0.5; }
</style>
