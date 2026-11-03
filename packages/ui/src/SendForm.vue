<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useWalletClient } from './wallet-client-key.js';
import { useNetworkInfo, useWalletBalance } from './composables/useWalletState.js';
import { getArkadeExplorerTxUrl, getMempoolTxUrl, decodeInvoice, classifyPaymentTarget, type LightningPaymentQuote, type OnchainSendQuote } from '@inscrib3/core';
import TxList from './TxList.vue';
import { coinKey, useCoinControl } from './composables/useCoinControl.js';
import CoinControlPanel from './CoinControlPanel.vue';

// Embedded in SendView, which owns the recipient field and passes it in:
// Ark address, Bitcoin address, BOLT11 invoice or bitcoin: URI. Its rail
// decides the mode ('onchain' is a collaborative exit through the server).
const props = defineProps<{ recipient: string }>();

type SendMode = 'ark' | 'onchain' | 'lightning';
const mode = ref<SendMode>('ark');
const address = ref('');
const amountSats = ref('');
const loading = ref(false);
const txid = ref('');
const error = ref('');

const lightningInvoice = ref('');
const lightningAvailable = ref<boolean | null>(null);
const lightningPreimage = ref('');
const lightningQuote = ref<LightningPaymentQuote | null>(null);
// A quote belongs to one invoice; editing the invoice discards it.
watch(lightningInvoice, () => {
  lightningQuote.value = null;
});

// null while the invoice is empty or not yet valid.
const lightningInvoiceAmountSats = computed(() => {
  const raw = lightningInvoice.value.trim();
  if (!raw) return null;
  try {
    return decodeInvoice(raw).amountSats;
  } catch {
    return null;
  }
});

// True while `amountSats` came from a BIP21 URI rather than the user.
const amountFromUri = ref(false);

const detection = computed(() => classifyPaymentTarget(props.recipient));

watch(() => props.recipient, () => {
  error.value = '';
  const result = detection.value;
  if (!result.ok) return;
  const { rail, target, amountSats: uriAmount } = result.target;

  if (rail === 'ark') mode.value = 'ark';
  else if (rail === 'lightning') mode.value = 'lightning';
  else mode.value = 'onchain';

  if (rail === 'lightning') {
    lightningInvoice.value = target;
    address.value = '';
  } else {
    address.value = target;
    lightningInvoice.value = '';
    // Only a URI-filled amount is replaced or cleared, never one the user typed.
    if (uriAmount !== undefined) {
      amountSats.value = String(uriAmount);
      amountFromUri.value = true;
    } else if (amountFromUri.value) {
      amountSats.value = '';
      amountFromUri.value = false;
    }
  }
}, { immediate: true });

const txList = ref<InstanceType<typeof TxList> | null>(null);

const { network, esploraUrl, refresh: refreshNetwork } = useNetworkInfo();
const { balance, loading: balanceLoading, refresh: refreshBalance } = useWalletBalance();

const client = useWalletClient();
onMounted(() => {
  refreshNetwork();
  refreshBalance();
  client.isLightningAvailable()
    .then((v) => { lightningAvailable.value = v; })
    .catch(() => { lightningAvailable.value = false; });
});
// Ark exits return a real Bitcoin txid (mempool); Ark sends and Lightning
// payments return an Ark txid (Arkade Explorer).
const sentOnchain = ref(false);
const explorerLink = computed(() => {
  if (!txid.value) return null;
  if (sentOnchain.value) {
    const url = esploraUrl.value ? getMempoolTxUrl(esploraUrl.value, txid.value) : null;
    return url ? { url, label: 'View on mempool' } : null;
  }
  const url = network.value ? getArkadeExplorerTxUrl(network.value, txid.value) : null;
  return url ? { url, label: 'View on Arkade Explorer' } : null;
});

// Offboard fees come out of the VTXO total, so sending the raw `available`
// as an exact amount fails. Max remembers it was max and sends "everything
// after fees" (amount undefined) unless edited.
const sendingMaxOnchain = ref(false);

const maxAvailableSats = computed<number | null>(() => {
  if (!balance.value) return null;
  if (mode.value === 'ark' || mode.value === 'onchain') return balance.value.available;
  return null;
});

function setMax() {
  if (maxAvailableSats.value === null) return;
  amountSats.value = String(maxAvailableSats.value);
  sendingMaxOnchain.value = mode.value === 'onchain';
}

// Ark exit fee, added on top of the amount; refreshed as the user types.
const exitQuote = ref<OnchainSendQuote | null>(null);
const exitQuoteError = ref('');
let exitQuoteTimer: ReturnType<typeof setTimeout> | undefined;
watch([mode, address, amountSats, sendingMaxOnchain], () => {
  exitQuote.value = null;
  exitQuoteError.value = '';
  clearTimeout(exitQuoteTimer);
  const to = address.value.trim();
  const amount = Number(amountSats.value);
  if (mode.value !== 'onchain' || sendingMaxOnchain.value || !to || !Number.isInteger(amount) || amount <= 0) return;
  exitQuoteTimer = setTimeout(async () => {
    try {
      const quote = await client.quoteOnchainSend(to, amount);
      // Ignore a stale answer if the inputs changed meanwhile.
      if (address.value.trim() === to && Number(amountSats.value) === amount) exitQuote.value = quote;
    } catch (e: unknown) {
      exitQuoteError.value = String(e);
    }
  }, 400);
});

function onAmountEdited() {
  sendingMaxOnchain.value = false;
  // The user has taken the amount over, so a later paste must not clear it.
  amountFromUri.value = false;
}

// --- Coin control (Ark mode only) ---
const {
  showCoinControl,
  coins: spendableVtxos,
  coinsLoading: spendableVtxosLoading,
  coinsError: spendableVtxosError,
  selectedOutpoints,
  selectedTotal: selectedVtxoTotal,
  coinControlActive,
  toggleCoinControl,
  toggleCoinSelected: toggleVtxoSelected,
  resetCoinControl,
  chosenOutpoints: selectedVtxos,
  onSelectionStale,
} = useCoinControl(() => client.getSpendableVtxos?.() ?? Promise.resolve([]));

// The SDK spends exactly the selected coins, so block a shortfall here.
const coinControlShortfall = computed(() => {
  if (!coinControlActive.value) return false;
  const amount = amountSats.value ? Number(amountSats.value) : 0;
  return selectedVtxoTotal.value < amount;
});

async function send() {
  txid.value = '';
  error.value = '';
  if (!address.value.trim()) { error.value = 'Address is required'; return; }

  // Number(), not parseInt(): parseInt turns "1e3" and "1.5" into 1.
  const amount = amountSats.value ? Number(amountSats.value) : undefined;
  if (!amount || !Number.isInteger(amount) || amount <= 0) { error.value = 'Invalid amount'; return; }
  if (maxAvailableSats.value !== null && amount > maxAvailableSats.value) {
    error.value = 'Amount exceeds your balance';
    return;
  }
  if (mode.value === 'onchain' && exitQuote.value && maxAvailableSats.value !== null && exitQuote.value.total > maxAvailableSats.value) {
    error.value = 'Amount plus the exit fee exceeds your balance';
    return;
  }
  if (coinControlShortfall.value) {
    error.value = 'Selected coins add up to less than the amount - select more, or clear the selection to spend automatically.';
    return;
  }

  const chosenVtxos = selectedVtxos();

  loading.value = true;
  try {
    let result: string;
    if (mode.value === 'ark') {
      result = await client.send(address.value.trim(), amount, chosenVtxos);
    } else {
      result = await client.sendOnchain(address.value.trim(), sendingMaxOnchain.value ? undefined : amount);
    }
    txid.value = result;
    sentOnchain.value = mode.value !== 'ark';
    amountSats.value = '';
    sendingMaxOnchain.value = false;
    resetCoinControl();
    txList.value?.refresh();
    void refreshBalance();
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes('SELECTED_VTXOS_NO_LONGER_SPENDABLE')) {
      error.value = 'One of your selected coins is no longer spendable - the list below has been refreshed, pick again.';
      onSelectionStale();
    } else if (msg.includes('BLOCKED_BY_EXPIRING_VTXO')) {
      // The raw server text stays visible: the friendly guess may not be the cause.
      error.value = `Can't complete this exit right now — the server rejected one of your VTXOs, usually because it is too close to its own expiry. This doesn't affect your balance; try again later. Server said: ${msg.replace(/^.*BLOCKED_BY_EXPIRING_VTXO:\s*/, '')}`;
    } else if (msg.includes('AMOUNT_TOO_LOW')) {
      error.value = describeAmountTooLow(msg);
    } else {
      error.value = msg;
    }
  } finally {
    loading.value = false;
  }
}

// The server rejects any Ark output below its minimum. Output #0 is the
// recipient; a later one is the change coming back to this wallet.
function describeAmountTooLow(msg: string): string {
  const minimum = msg.match(/min vtxo amount: (\d+)/)?.[1];
  const limit = minimum ? `${Number(minimum).toLocaleString()} sats` : 'its minimum';
  if (/output #0\b/.test(msg)) {
    return `Amount too low: the Ark server only accepts sends of at least ${limit}. Nothing was sent.`;
  }
  return `The change coming back to you would be below the Ark server's minimum of ${limit}. Pick coins that leave at least that much change, or send a coin's full value. Nothing was sent.`;
}

// Two steps so the swap fee is shown before anything is paid.
async function reviewPayment() {
  txid.value = '';
  error.value = '';
  lightningPreimage.value = '';
  if (!lightningInvoice.value.trim()) { error.value = 'Lightning invoice is required'; return; }

  loading.value = true;
  try {
    lightningQuote.value = await client.prepareLightningPayment(lightningInvoice.value.trim());
  } catch (e: unknown) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function confirmPayment() {
  const quote = lightningQuote.value;
  if (!quote) return;
  error.value = '';
  loading.value = true;
  try {
    const result = await client.confirmLightningPayment(quote.quoteId);
    txid.value = result.txid;
    sentOnchain.value = false;
    lightningPreimage.value = result.preimage;
    lightningInvoice.value = '';
    void refreshBalance();
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes('LIGHTNING_QUOTE_EXPIRED')) error.value = 'This quote expired - review the payment again.';
    else error.value = msg.replace(/^.*LIGHTNING_PAYMENT_(FAILED|PENDING):\s*/, '');
  } finally {
    lightningQuote.value = null;
    loading.value = false;
  }
}
</script>

<template>
  <div class="send-form">
    <template v-if="mode !== 'lightning'">
      <label>
        Amount (sats)
        <input
          type="number"
          placeholder="1000"
          min="1"
          v-model="amountSats"
          :disabled="loading"
          @input="onAmountEdited"
        />
      </label>
      <p
        v-if="maxAvailableSats !== null"
        class="max-line"
        :class="{ disabled: loading || balanceLoading }"
        @click="!(loading || balanceLoading) && setMax()"
      >
        Max: <span class="max-value">{{ maxAvailableSats.toLocaleString() }} sats</span>
      </p>
      <span v-if="sendingMaxOnchain" class="max-hint">Sending everything - the exit fee comes out of it</span>

      <template v-if="mode === 'onchain'">
        <p class="hint">
          Withdraws Ark funds to a plain Bitcoin address (collaborative exit). The exit fee is added on top: the receiver gets exactly the amount above.
        </p>
        <div v-if="exitQuote" class="quote-box">
          <div class="quote-row"><span>Receiver gets</span><span>{{ exitQuote.amount.toLocaleString() }} sats</span></div>
          <div class="quote-row"><span>Exit fee (added)</span><span>{{ exitQuote.fee.toLocaleString() }} sats</span></div>
          <div class="quote-row total"><span>Total sent</span><span>{{ exitQuote.total.toLocaleString() }} sats</span></div>
        </div>
        <!-- A failed Send repeats the same reason in red; show it once. -->
        <p v-else-if="exitQuoteError && exitQuoteError !== error" class="hint warning">Can't send this amount onchain: {{ exitQuoteError }}</p>
      </template>

      <CoinControlPanel
        v-if="mode === 'ark' && client.getSpendableVtxos"
        :open="showCoinControl"
        :loading="spendableVtxosLoading"
        :error="spendableVtxosError"
        :is-empty="spendableVtxos.length === 0"
        empty-text="No spendable VTXOs"
        :selected-count="selectedOutpoints.size"
        @toggle="toggleCoinControl"
      >
        <label class="coin-row" v-for="v in spendableVtxos" :key="coinKey(v)">
          <input type="checkbox" :checked="selectedOutpoints.has(coinKey(v))" @change="toggleVtxoSelected(v)" :disabled="loading" />
          <span class="coin-amount">{{ v.value.toLocaleString() }} sats</span>
          <span class="coin-status" :class="v.status">{{ v.status }}</span>
        </label>
        <p class="hint coin-total" :class="{ error: coinControlShortfall }">
          Selected: {{ selectedVtxoTotal.toLocaleString() }} sats
        </p>
      </CoinControlPanel>
    </template>

    <template v-else>
      <p v-if="lightningAvailable === null" class="hint">Checking Lightning availability…</p>
      <p v-else-if="lightningAvailable === false" class="hint">
        Lightning is unavailable right now. It only works on mainnet - on testnets there is no swap provider.
      </p>
      <template v-else>
        <p v-if="lightningInvoiceAmountSats !== null" class="amount-line">
          {{ lightningInvoiceAmountSats.toLocaleString() }} <span class="amount-unit">sats</span>
        </p>
        <p v-else-if="lightningInvoice.trim()" class="hint">Couldn't read an amount from this invoice - check it was pasted in full.</p>
        <p class="hint">Pays a BOLT11 invoice out of your Ark balance via a swap. Review shows the swap fee before anything is paid.</p>
        <div v-if="lightningQuote" class="quote-box">
          <div class="quote-row"><span>Invoice</span><span>{{ lightningQuote.invoiceAmountSats.toLocaleString() }} sats</span></div>
          <div class="quote-row"><span>Swap fee</span><span>{{ lightningQuote.feeSats.toLocaleString() }} sats</span></div>
          <div class="quote-row total"><span>Total</span><span>{{ lightningQuote.totalSats.toLocaleString() }} sats</span></div>
        </div>
      </template>
    </template>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="txid" class="success">
      <p>{{ mode === 'lightning' ? 'Paid!' : 'Sent!' }}</p>
      <p class="txid">{{ txid }}</p>
      <p v-if="lightningPreimage" class="txid">Preimage: {{ lightningPreimage }}</p>
      <a v-if="explorerLink" :href="explorerLink.url" target="_blank" rel="noopener noreferrer" class="explorer-link">
        {{ explorerLink.label }} ↗
      </a>
    </div>

    <template v-if="mode === 'lightning' && lightningQuote">
      <button class="submit-btn" @click="confirmPayment" :disabled="loading">
        {{ loading ? 'Paying…' : `Pay ${lightningQuote.totalSats.toLocaleString()} sats` }}
      </button>
      <button class="submit-btn secondary" @click="lightningQuote = null" :disabled="loading">Cancel</button>
    </template>
    <button
      v-else
      class="submit-btn"
      @click="mode === 'lightning' ? reviewPayment() : send()"
      :disabled="loading || (mode === 'lightning' ? (!lightningInvoice || lightningAvailable !== true) : (!address || !amountSats || coinControlShortfall))"
    >
      {{ mode === 'lightning' ? (loading ? 'Getting quote…' : 'Review payment') : (loading ? 'Sending…' : 'Send') }}
    </button>

    <TxList
      v-if="mode === 'ark'"
      ref="txList"
      type="send"
      layer="ark"
    />
  </div>
</template>

<style scoped>
.send-form { display: flex; flex-direction: column; gap: 16px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #aaa; }
.max-hint { color: var(--color-accent); font-size: 11px; }
input {
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text);
  font-size: 14px;
  padding: 10px 12px;
  width: 100%;
}
.max-line {
  margin-top: -8px;
  font-size: 12px;
  color: var(--color-text-muted);
  cursor: pointer;
  width: fit-content;
}
.max-line.disabled { cursor: not-allowed; opacity: 0.6; }
.max-value { color: var(--color-accent); font-weight: 700; }
.hint { color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.hint.warning { color: #e0a030; }
.amount-line { font-size: 20px; font-weight: 700; font-family: monospace; color: var(--color-text); }
.amount-unit { font-size: 12px; font-weight: 500; color: var(--color-text-muted); }
button.submit-btn {
  background: var(--color-accent);
  border: none;
  border-radius: 8px;
  color: var(--color-accent-text);
  cursor: pointer;
  font-size: 15px;
  font-weight: 600;
  padding: 12px;
  width: 100%;
}
button.submit-btn.secondary { background: var(--color-surface-alt); color: var(--color-text); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.quote-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
  font-size: 13px;
}
.quote-row { display: flex; justify-content: space-between; color: var(--color-text-muted); }
.quote-row.total { color: var(--color-text); font-weight: 700; }
.error { color: var(--color-error); font-size: 13px; }
.success {
  background: #0d1f0d;
  border: 1px solid #2a5c2a;
  border-radius: 8px;
  padding: 12px;
  font-size: 13px;
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
  margin-top: 8px;
  color: var(--color-accent-secondary);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
.explorer-link:hover { text-decoration: underline; }
</style>
