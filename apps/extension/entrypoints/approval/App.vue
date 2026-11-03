<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApprovalRequestBody } from '@inscrib3/ui';
import { sendToBackground } from '../../src/lib/messaging/popup-client.js';

type RequestType =
  | 'connect'
  | 'sendToAddress'
  | 'sendAsset'
  | 'settle'
  | 'signMessage'
  | 'unknown';

interface AssetLine {
  assetId: string;
  amount: number;
}

const requestType = ref<RequestType>('unknown');
const origin = ref('');
const address = ref('');
const amount = ref<number | null>(null);
const assets = ref<AssetLine[]>([]);
const message = ref('');
const network = ref('');
const account = ref('');
const loading = ref(false);
const error = ref('');
// Approve stays disabled briefly after the window opens, so a click meant for
// the page underneath can't land on it.
const APPROVE_DELAY_MS = 1000;
const armed = ref(false);

// Shows a malformed param as '—' instead of crashing the popup.
function sats(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '—';
}

onMounted(() => {
  setTimeout(() => (armed.value = true), APPROVE_DELAY_MS);
  const params = new URLSearchParams(window.location.search);
  requestType.value = (params.get('type') as RequestType) ?? 'unknown';
  origin.value = params.get('origin') ?? '';
  address.value = params.get('address') ?? '';
  const amountParam = params.get('amount');
  amount.value = amountParam ? Number(amountParam) : null;
  message.value = params.get('message') ?? '';
  network.value = params.get('network') ?? '';
  account.value = params.get('account') ?? '';

  const assetsParam = params.get('assets');
  if (assetsParam) {
    try {
      assets.value = JSON.parse(assetsParam);
    } catch {
      assets.value = [];
    }
  }
});

async function respond(approved: boolean) {
  loading.value = true;
  error.value = '';
  try {
    const approvalId = new URLSearchParams(window.location.search).get('id') ?? '';
    await sendToBackground('approval_respond', { approvalId, approved });
    window.close();
  } catch (e: unknown) {
    // Stay open on failure so the user can read why.
    error.value = String(e);
    loading.value = false;
  }
}
</script>

<template>
  <div class="approval">
    <div class="origin-badge">{{ origin || 'Unknown origin' }}</div>
    <div v-if="network || account" class="wallet-context" :class="{ mainnet: network === 'Mainnet' }">
      {{ network }}<template v-if="network && account"> · </template>{{ account }}
    </div>

    <ApprovalRequestBody
      v-if="requestType === 'connect' || requestType === 'sendToAddress'"
      :kind="requestType === 'connect' ? 'connect' : 'send'"
      :address="address"
      :amount="amount"
    />

    <template v-else-if="requestType === 'signMessage'">
      <h1>Sign this message?</h1>
      <div class="tx-details">
        <div class="row">
          <span class="label">Message</span>
          <span class="value message-body">{{ message }}</span>
        </div>
      </div>
      <p class="description">
        Signing proves you control this wallet's key. It moves no funds and costs
        nothing, but a site can use the signature to prove who you are — only sign
        messages you understand.
      </p>
    </template>

    <template v-else-if="requestType === 'sendAsset'">
      <h1>Send asset?</h1>
      <div class="tx-details">
        <div class="row" v-for="a in assets" :key="a.assetId">
          <span class="label">Asset</span>
          <span class="value mono">{{ a.assetId }} — {{ sats(a.amount) }}</span>
        </div>
        <div class="row" v-if="amount !== null">
          <span class="label">Plus BTC</span>
          <span class="value">{{ sats(amount) }} sats</span>
        </div>
        <div class="row">
          <span class="label">To</span>
          <span class="value mono">{{ address || '—' }}</span>
        </div>
      </div>
      <p class="description">
        This will broadcast a real transaction from your wallet. Make sure
        you trust this site before approving.
      </p>
    </template>

    <template v-else-if="requestType === 'settle'">
      <h1>Settle virtual outputs?</h1>
      <p class="description">
        This will move your preconfirmed virtual outputs into a settled,
        on-chain-backed state. This broadcasts a real transaction.
      </p>
    </template>

    <template v-else>
      <h1>Unknown request</h1>
      <p class="description">This request type isn't recognized. Reject it to be safe.</p>
    </template>

    <p v-if="error" class="description warning">{{ error }}</p>

    <div class="actions">
      <button class="btn-reject" :disabled="loading" @click="respond(false)">Reject</button>
      <button class="btn-approve" :disabled="loading || !armed" @click="respond(true)">Approve</button>
    </div>
  </div>
</template>

<style scoped>
/* scroll, never truncate: the user must see the whole message */
.message-body {
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
  max-height: 160px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.approval {
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 100vh;
}
.origin-badge {
  align-self: flex-start;
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  color: #aaa;
  word-break: break-all;
}
.wallet-context { font-size: 12px; color: var(--color-text-muted); }
.wallet-context.mainnet { color: var(--color-accent); font-weight: 600; }
h1 { font-size: 19px; font-weight: 700; }
.description { color: #999; font-size: 13px; line-height: 1.5; }
.description.warning { color: #ff8a80; }
.tx-details {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tx-details.danger { border-color: #5c2a2a; }
.row { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.label { color: var(--color-text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
.value { color: var(--color-text); }
.mono { font-family: monospace; font-size: 12px; word-break: break-all; }
.actions { display: flex; gap: 12px; margin-top: auto; }
button {
  flex: 1;
  padding: 12px;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-reject { background: var(--color-surface-alt); color: var(--color-text); }
.btn-approve { background: var(--color-accent); color: var(--color-accent-text); }
</style>
