<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { classifyPaymentTarget, type AssetEntry } from '@inscrib3/core';
import { useWalletClient } from './wallet-client-key.js';
import { useWalletBalance } from './composables/useWalletState.js';
import Icon from './Icon.vue';
import AssetPicker, { type AssetPickerOption } from './AssetPicker.vue';
import SendForm from './SendForm.vue';
import ArkAssetSendForm from './ArkAssetSendForm.vue';
import { formatAssetAmount } from './format.js';

// One Send screen for everything: pick what to send, paste where, and the
// recipient decides the route. Asset keys: 'btc', 'ark:<assetId>'.
const props = defineProps<{ initialAsset?: string }>();

const client = useWalletClient();
const { balance, refresh: refreshBalance } = useWalletBalance();
const arkAssets = ref<AssetEntry[]>([]);

const asset = ref(props.initialAsset ?? 'btc');
const recipient = ref('');

onMounted(() => {
  void refreshBalance();
  client.getAssets().then((a) => (arkAssets.value = a), () => {});
});

// Boarding funds can't be spent from Send until they settle into Ark.
const arkadeSats = computed(() => balance.value?.available ?? 0);

const assetOptions = computed<AssetPickerOption<string>[]>(() => [
  { value: 'btc', label: 'BTC', amount: `${arkadeSats.value.toLocaleString()} sats`, iconLetter: '₿' },
  ...arkAssets.value.map((a) => ({
    value: `ark:${a.assetId}`,
    label: a.metadata?.ticker ?? a.metadata?.name ?? `${a.assetId.slice(0, 8)}…`,
    amount: formatAssetAmount(a),
    iconLetter: (a.metadata?.ticker ?? 'A').slice(0, 1).toUpperCase(),
    iconUrl: a.metadata?.icon,
  })),
]);

const selectedArkAsset = computed(() =>
  asset.value.startsWith('ark:') ? arkAssets.value.find((a) => `ark:${a.assetId}` === asset.value) ?? null : null,
);

const placeholder = computed(() =>
  asset.value.startsWith('ark:') ? 'Ark address (ark1…)' : 'Ark address, Bitcoin address, or Lightning invoice',
);

const detection = computed(() => classifyPaymentTarget(recipient.value));
const detectedLabel = computed(() => {
  if (!recipient.value.trim() || !detection.value.ok) return '';
  return { ark: 'Ark address', onchain: 'Bitcoin address', lightning: 'Lightning invoice' }[detection.value.target.rail];
});

type Route =
  | { form: 'arkade' }
  | { form: 'ark-asset'; asset: AssetEntry; target: string }
  | { form: 'error'; message: string };

// Which form pays this asset to this recipient.
const route = computed<Route | null>(() => {
  const result = detection.value;
  if (!recipient.value.trim()) return null;
  if (!result.ok) return { form: 'error', message: result.reason };
  const { rail, target } = result.target;

  if (asset.value.startsWith('ark:')) {
    if (rail !== 'ark') return { form: 'error', message: 'Ark assets can only be sent to an Ark address (ark1…).' };
    return selectedArkAsset.value ? { form: 'ark-asset', asset: selectedArkAsset.value, target } : null;
  }
  return { form: 'arkade' };
});
</script>

<template>
  <div class="send-view">
    <label>
      What to send
      <AssetPicker :options="assetOptions" :model-value="asset" @update:model-value="asset = $event" />
    </label>

    <label>
      Send to
      <textarea rows="2" :placeholder="placeholder" v-model="recipient"></textarea>
    </label>
    <p v-if="detectedLabel" class="detected">
      <Icon name="check-circle" :size="13" />
      {{ detectedLabel }}
    </p>
    <p v-if="detection.ok && detection.target.note && asset === 'btc'" class="hint">{{ detection.target.note }}</p>

    <p v-if="route?.form === 'error'" class="hint warning">{{ route.message }}</p>
    <SendForm v-else-if="route?.form === 'arkade'" :recipient="recipient" />
    <ArkAssetSendForm v-else-if="route?.form === 'ark-asset'" :key="route.asset.assetId" :asset="route.asset" :recipient="route.target" />
  </div>
</template>

<style scoped>
.send-view { display: flex; flex-direction: column; gap: 12px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #aaa; }
textarea {
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text);
  font-family: monospace;
  font-size: 12px;
  padding: 10px 12px;
  resize: none;
  width: 100%;
}
.detected { display: flex; align-items: center; gap: 4px; color: var(--color-success); font-size: 12px; font-weight: 600; margin-top: -6px; }
.hint { color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.hint.warning { color: #e0a030; }
</style>
