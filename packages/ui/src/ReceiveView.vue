<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { createUnifiedReceiveUri } from '@inscrib3/core';
import { useWalletAddresses } from './composables/useWalletState.js';
import { useCopyToClipboard } from './composables/useCopyToClipboard.js';
import Icon from './Icon.vue';
import QrCode from './QrCode.vue';
import TxList from './TxList.vue';
import ToggleGroup from './ToggleGroup.vue';
import LightningReceive from './LightningReceive.vue';
import { RECEIVE_MODE_OPTIONS, type ReceiveMode } from './mode-options.js';

// refreshKey reloads only the transaction lists: remounting the whole view
// on incoming funds would wipe an invoice still waiting to be paid.
const props = defineProps<{ refreshKey?: number }>();

const arkadeMode = ref<ReceiveMode>('unified');

const { address, boardingAddress, loading, error, refresh } = useWalletAddresses();
const unifiedUri = computed(() =>
  address.value && boardingAddress.value ? createUnifiedReceiveUri(boardingAddress.value, address.value) : '',
);
const { copied: unifiedCopied, copy: copyUnified } = useCopyToClipboard();
const { copied: addressCopied, copy: copyAddress } = useCopyToClipboard();
const { copied: boardingCopied, copy: copyBoardingAddress } = useCopyToClipboard();

onMounted(() => {
  void refresh();
});
</script>

<template>
  <div class="receive">
    <p v-if="loading" class="hint">Loading…</p>
    <p v-else-if="error" class="error">{{ error }}</p>
    <template v-else>
      <ToggleGroup :options="RECEIVE_MODE_OPTIONS" v-model="arkadeMode" />

      <template v-if="arkadeMode === 'unified'">
        <QrCode :value="unifiedUri" :size="180" />
        <p class="section-title mt">Unified (Ark + boarding)</p>
        <p class="hint">
          One code for any Bitcoin wallet: an Ark-aware wallet pays your Ark address instantly offchain, any other wallet pays your boarding address onchain.
        </p>
        <div class="address-box">
          <span class="address-text">{{ unifiedUri }}</span>
          <button type="button" class="copy-icon-btn" @click="copyUnified(unifiedUri)" title="Copy payment link">
            <Icon :name="unifiedCopied ? 'check' : 'copy'" :size="14" />
          </button>
        </div>
      </template>

      <template v-else-if="arkadeMode === 'ark'">
        <QrCode :value="address" :size="180" />
        <p class="section-title mt">Ark address (offchain)</p>
        <div class="address-box">
          <span class="address-text">{{ address }}</span>
          <button type="button" class="copy-icon-btn" @click="copyAddress(address)" title="Copy address">
            <Icon :name="addressCopied ? 'check' : 'copy'" :size="14" />
          </button>
        </div>
        <TxList :key="props.refreshKey" type="receive" layer="ark" />
      </template>

      <template v-else-if="arkadeMode === 'onchain'">
        <QrCode :value="boardingAddress" :size="180" />
        <p class="section-title mt">Boarding address (onchain)</p>
        <p class="hint">
          This is Arkade's boarding address, not a plain wallet address - Bitcoin sent here becomes part of your Ark balance once the server picks it up in the next round, rather than staying as a plain onchain coin you hold directly.
        </p>
        <div class="address-box">
          <span class="address-text">{{ boardingAddress }}</span>
          <button type="button" class="copy-icon-btn" @click="copyBoardingAddress(boardingAddress)" title="Copy address">
            <Icon :name="boardingCopied ? 'check' : 'copy'" :size="14" />
          </button>
        </div>
        <TxList :key="props.refreshKey" type="receive" layer="onchain" />
      </template>

      <LightningReceive v-else />
    </template>
  </div>
</template>

<style scoped>
.receive { display: flex; flex-direction: column; gap: 8px; }
.hint { color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.error { color: var(--color-error); font-size: 13px; }
.section-title { font-size: 12px; color: var(--color-text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.mt { margin-top: 16px; }
.address-box {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-family: monospace;
  font-size: 11px;
  padding: 12px;
  color: #ccc;
  line-height: 1.5;
}
.address-text { flex: 1; min-width: 0; word-break: break-all; }
.copy-icon-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px;
}
.copy-icon-btn:hover { color: var(--color-accent); }
</style>
