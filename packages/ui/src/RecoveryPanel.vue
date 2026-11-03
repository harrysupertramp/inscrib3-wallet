<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useWalletClient } from './wallet-client-key.js';
import { getMempoolTxUrl, type ExitQuote, type ExecutorEvent } from '@inscrib3/core';
import { useNetworkInfo } from './composables/useWalletState.js';

const client = useWalletClient();

type Phase = 'idle' | 'quoted' | 'in-progress' | 'done';
const phase = ref<Phase>('idle');

const sweepAddress = ref('');
const quote = ref<ExitQuote | null>(null);
const quoteLoading = ref(false);
const quoteError = ref('');
// The quote's fundingAddress is always empty in graph mode; fees are paid via
// CPFP from the SDK's onchain wallet, so that is the address to fund.
const feeAddress = ref('');
const feeAddressError = ref('');

async function loadFeeAddress(): Promise<void> {
  try {
    feeAddress.value = await client.getExitFeeAddress();
    feeAddressError.value = '';
  } catch (e: unknown) {
    feeAddressError.value = String(e);
  }
}

const starting = ref(false);
const startError = ref('');

const checking = ref(false);
const checkError = ref('');
const log = ref<ExecutorEvent[]>([]);

function sats(n: number): string {
  return n.toLocaleString();
}

// Recovery transactions are all onchain.
const { esploraUrl, refresh: refreshNetwork } = useNetworkInfo();
function mempoolUrl(txid: string): string | null {
  return esploraUrl.value ? getMempoolTxUrl(esploraUrl.value, txid) : null;
}

function shortTxid(txid: string): string {
  return `${txid.slice(0, 8)}…${txid.slice(-8)}`;
}

function eventLabel(event: ExecutorEvent): string {
  switch (event.status) {
    case 'broadcast': return 'Broadcasting transaction…';
    case 'confirmed': return 'Confirmed onchain';
    case 'waiting_csv': return 'Waiting for timelock to mature';
    case 'skipped': return 'Already handled';
    case 'failed': return event.reason ? `Failed: ${event.reason}` : 'Failed';
    case 'warning': return event.reason ?? 'Warning';
    default: return event.status;
  }
}

async function getQuote() {
  quoteError.value = '';
  if (!sweepAddress.value.trim()) { quoteError.value = 'Destination address is required'; return; }
  quoteLoading.value = true;
  try {
    // Without it the quote would ask the user to fund a blank address.
    if (!feeAddress.value) await loadFeeAddress();
    if (!feeAddress.value) {
      quoteError.value = `Couldn't get the address that pays the fees: ${feeAddressError.value}`;
      return;
    }
    quote.value = await client.estimateExit(sweepAddress.value.trim());
    phase.value = 'quoted';
  } catch (e: unknown) {
    quoteError.value = String(e);
  } finally {
    quoteLoading.value = false;
  }
}

function backToIdle() {
  phase.value = 'idle';
  quote.value = null;
  quoteError.value = '';
}

async function startRecovery() {
  startError.value = '';
  starting.value = true;
  try {
    await client.startExit(sweepAddress.value.trim());
    log.value = [];
    phase.value = 'in-progress';
  } catch (e: unknown) {
    startError.value = String(e);
  } finally {
    starting.value = false;
  }
}

async function checkProgress() {
  checkError.value = '';
  checking.value = true;
  try {
    const result = await client.getExitProgress();
    log.value = [...log.value, ...result.events];
    if (result.done) phase.value = 'done';
  } catch (e: unknown) {
    checkError.value = String(e);
  } finally {
    checking.value = false;
  }
}

// "done" only means nothing is left to check, not that every step succeeded.
const hasFailures = computed(() => log.value.some((e) => e.status === 'failed'));

function startOver() {
  phase.value = 'idle';
  quote.value = null;
  log.value = [];
  quoteError.value = '';
  startError.value = '';
  checkError.value = '';
}

onMounted(async () => {
  void refreshNetwork();
  // Needed in every phase: a resumed exit can still run short of fees.
  void loadFeeAddress();
  try {
    if (await client.hasPendingExit()) phase.value = 'in-progress';
  } catch {
    // default to idle
  }
});
</script>

<template>
  <section class="recovery">
    <h2>Emergency recovery</h2>
    <p class="hint warning">
      Only use this if you can't use the wallet normally, or don't trust the Ark server. It moves your funds directly onto the Bitcoin blockchain using each VTXO's own timelocked exit path — no Ark server involved. This is a real onchain process and can take hours to days to fully complete.
    </p>

    <template v-if="phase === 'idle'">
      <label>
        Destination Bitcoin address
        <input type="text" placeholder="bc1…" v-model="sweepAddress" :disabled="quoteLoading" />
      </label>
      <p v-if="quoteError" class="error">{{ quoteError }}</p>
      <button @click="getQuote" :disabled="quoteLoading || !sweepAddress">
        {{ quoteLoading ? 'Getting quote…' : 'Get quote' }}
      </button>
    </template>

    <template v-else-if="phase === 'quoted' && quote">
      <div class="quote-box">
        <div class="row"><span>Transactions needed</span><span>{{ quote.totals.txCount }}</span></div>
        <div class="row"><span>Estimated fees</span><span>{{ sats(quote.totals.totalFeeSats) }} sats</span></div>
        <div class="row"><span>You'll recover</span><span>{{ sats(quote.totals.recoveredSats) }} sats</span></div>
      </div>
      <p class="hint">
        Fees for this are paid from this wallet's own onchain address below, not the boarding address. Send only plain BTC there: any coin on it can be spent as a fee. Send at least <strong>{{ sats(quote.shortfallSats) }} sats</strong> before starting (skip if it already holds enough):
      </p>
      <p class="mono-box">{{ feeAddress }}</p>
      <p v-if="startError" class="error">{{ startError }}</p>
      <button @click="startRecovery" :disabled="starting">{{ starting ? 'Starting…' : 'Start recovery' }}</button>
      <button type="button" class="secondary" @click="backToIdle" :disabled="starting">Back</button>
    </template>

    <template v-else-if="phase === 'in-progress'">
      <p class="hint">
        Recovery in progress. This can take hours to days — come back and check anytime; nothing is lost by closing this.
      </p>
      <p v-if="feeAddress" class="hint">Fees are paid from:</p>
      <p v-if="feeAddress" class="mono-box">{{ feeAddress }}</p>
      <p v-if="checkError" class="error">{{ checkError }}</p>
      <div v-if="log.length > 0" class="log">
        <div class="log-row" v-for="(event, i) in log" :key="i">
          <span>{{ eventLabel(event) }}</span>
          <a
            v-if="event.txid && mempoolUrl(event.txid)"
            :href="mempoolUrl(event.txid)!"
            target="_blank"
            rel="noopener noreferrer"
            class="log-txid log-link"
          >{{ shortTxid(event.txid) }} ↗</a>
          <span v-else-if="event.txid" class="log-txid">{{ shortTxid(event.txid) }}</span>
        </div>
      </div>
      <button @click="checkProgress" :disabled="checking">{{ checking ? 'Checking…' : 'Check for progress' }}</button>
    </template>

    <template v-else-if="phase === 'done'">
      <template v-if="hasFailures">
        <p class="hint warning">
          Finished, but some steps failed — see below. Nothing was broadcast for those, so no funds were lost or moved; they're exactly where they were. The usual cause is not enough plain BTC at the fee address to cover fees. Fund it and try again:
        </p>
        <p v-if="feeAddress" class="mono-box">{{ feeAddress }}</p>
      </template>
      <p v-else class="success-hint">Recovery complete — funds have been swept to your destination address.</p>
      <div v-if="log.length > 0" class="log">
        <div class="log-row" v-for="(event, i) in log" :key="i">
          <span>{{ eventLabel(event) }}</span>
          <a
            v-if="event.txid && mempoolUrl(event.txid)"
            :href="mempoolUrl(event.txid)!"
            target="_blank"
            rel="noopener noreferrer"
            class="log-txid log-link"
          >{{ shortTxid(event.txid) }} ↗</a>
          <span v-else-if="event.txid" class="log-txid">{{ shortTxid(event.txid) }}</span>
        </div>
      </div>
      <button v-if="hasFailures" type="button" class="secondary" @click="startOver">Try again</button>
    </template>
  </section>
</template>

<style scoped>
.recovery { display: flex; flex-direction: column; gap: 10px; }
h2 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #ccc; }
.hint { color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.hint.warning { color: #e0a030; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #aaa; }
input {
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text);
  font-size: 13px;
  padding: 10px 12px;
  width: 100%;
}
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
button.secondary { background: var(--color-surface-alt); color: var(--color-text); margin-top: 8px; }
.error { color: var(--color-error); font-size: 13px; }
.success-hint { color: var(--color-success); font-size: 13px; }
.quote-box {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row { display: flex; justify-content: space-between; font-size: 13px; color: #aaa; }
.mono-box {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  font-family: monospace;
  font-size: 11px;
  padding: 12px;
  word-break: break-all;
  color: #ccc;
  line-height: 1.5;
}
.log { display: flex; flex-direction: column; gap: 6px; }
.log-row {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #ccc;
}
.log-txid { font-family: monospace; color: var(--color-text-muted); }
.log-link { color: var(--color-accent-secondary); text-decoration: none; }
</style>
