<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useWalletClient } from './wallet-client-key.js';
import { useCopyToClipboard } from './composables/useCopyToClipboard.js';
import { decodeInvoice } from '@inscrib3/core';
import Icon from './Icon.vue';
import QrCode from './QrCode.vue';

const client = useWalletClient();

interface InvoiceResult {
  invoice: string;
  swapId: string;
  expiresAt: number;
}

const available = ref<boolean | null>(null);
const amountSats = ref('');
const loading = ref(false);
const error = ref('');
const invoice = ref<InvoiceResult | null>(null);
const status = ref<'pending' | 'completed' | 'failed'>('pending');

let pollHandle: ReturnType<typeof setInterval> | null = null;

function stopPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

const { copied, copy } = useCopyToClipboard();

// Decoded from the returned invoice: what it actually commits to.
const invoiceAmountSats = computed(() => {
  if (!invoice.value) return null;
  try {
    return decodeInvoice(invoice.value.invoice).amountSats;
  } catch {
    return null;
  }
});

async function generate() {
  error.value = '';
  // Number(), not parseInt(): parseInt turns "1.5" into 1.
  const amount = Number(amountSats.value);
  if (!Number.isInteger(amount) || amount <= 0) { error.value = 'Invalid amount'; return; }

  loading.value = true;
  try {
    invoice.value = await client.createLightningInvoice(amount);
    status.value = 'pending';
    stopPolling();
    const swapId = invoice.value.swapId;
    // Read from the invoice itself, so the unit is always unix seconds.
    const expiresAt = invoiceAmountSats.value === null ? Infinity : decodeInvoice(invoice.value.invoice).expiresAt;
    pollHandle = setInterval(async () => {
      if (!invoice.value || invoice.value.swapId !== swapId) return;
      if (Date.now() / 1000 > expiresAt) {
        status.value = 'failed';
        stopPolling();
        return;
      }
      try {
        const result = await client.getLightningInvoiceStatus(swapId);
        // Ignore a stale response if a newer invoice replaced this one meanwhile.
        if (invoice.value?.swapId !== swapId) return;
        if (result.completed) {
          status.value = 'completed';
          stopPolling();
        } else if (result.failed) {
          status.value = 'failed';
          stopPolling();
        }
      } catch {
        // transient poll error - retry next tick
      }
    }, 3000);
  } catch (e: unknown) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function reset() {
  invoice.value = null;
  amountSats.value = '';
  stopPolling();
}

onMounted(async () => {
  try {
    available.value = await client.isLightningAvailable();
  } catch {
    available.value = false;
  }
});

onUnmounted(stopPolling);
</script>

<template>
  <div class="lightning-receive">
    <p v-if="available === null" class="hint">Checking Lightning availability…</p>
    <p v-else-if="available === false" class="hint">
      Lightning is unavailable right now. It only works on mainnet - on testnets there is no swap provider.
    </p>
    <template v-else-if="!invoice">
      <label>
        Amount (sats)
        <input type="number" placeholder="10000" min="1" v-model="amountSats" :disabled="loading" />
      </label>
      <p v-if="error" class="error">{{ error }}</p>
      <button @click="generate" :disabled="loading || !amountSats">
        {{ loading ? 'Generating…' : 'Generate Lightning invoice' }}
      </button>
    </template>
    <template v-else>
      <p class="section-title">Lightning invoice</p>
      <p v-if="invoiceAmountSats !== null" class="amount-line">{{ invoiceAmountSats.toLocaleString() }} <span class="amount-unit">sats</span></p>
      <QrCode :value="invoice.invoice" :size="180" />
      <div class="invoice-box" @click="copy(invoice.invoice)" :title="copied ? 'Copied!' : 'Click to copy'">{{ invoice.invoice }}</div>
      <p v-if="copied" class="copied-hint"><Icon name="check" :size="12" /> Copied</p>

      <div class="status" :class="status">
        <span v-if="status === 'pending'"><Icon name="clock" :size="14" /> Waiting for payment…</span>
        <span v-else-if="status === 'completed'"><Icon name="check-circle" :size="14" /> Received!</span>
        <span v-else><Icon name="x-circle" :size="14" /> Failed / expired</span>
      </div>

      <button class="secondary" @click="reset">New invoice</button>
    </template>
  </div>
</template>

<style scoped>
.lightning-receive { display: flex; flex-direction: column; gap: 12px; }
.hint { color: var(--color-text-muted); font-size: 13px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #aaa; }
input {
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text);
  font-size: 14px;
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
button.secondary { background: var(--color-surface-alt); color: var(--color-text); }
.error { color: var(--color-error); font-size: 13px; }
.section-title { font-size: 12px; color: var(--color-text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.amount-line { font-size: 22px; font-weight: 700; font-family: monospace; color: var(--color-text); }
.amount-unit { font-size: 13px; font-weight: 500; color: var(--color-text-muted); }
.invoice-box {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  font-family: monospace;
  font-size: 11px;
  padding: 12px;
  word-break: break-all;
  color: #ccc;
  line-height: 1.5;
  cursor: pointer;
}
.copied-hint { display: flex; align-items: center; gap: 4px; color: var(--color-success); font-size: 12px; margin-top: -4px; }
.status { font-size: 13px; text-align: center; padding: 8px; }
.status span { display: inline-flex; align-items: center; gap: 5px; }
.status.completed { color: var(--color-success); }
.status.failed { color: var(--color-error); }
</style>
