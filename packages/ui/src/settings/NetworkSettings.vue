<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NETWORK_PRESETS, type NetworkPreset } from '@inscrib3/core';
import { useWalletClient } from '../wallet-client-key.js';
import ToggleGroup, { type ToggleOption } from '../ToggleGroup.vue';

const client = useWalletClient();

const arkServerUrl = ref('');
const esploraUrl = ref('');
const networkLoading = ref(true);
const networkSaving = ref(false);
const networkSaved = ref(false);
const networkError = ref('');

const activePreset = computed(() => NETWORK_PRESETS.find((p) => p.arkServerUrl === arkServerUrl.value));
const isMainnetSelected = computed(() => activePreset.value?.network === 'bitcoin');
// Checks both URLs: a custom Esplora with a preset Ark server is still an
// unvetted party.
const isKnownPresetPair = computed(() =>
  NETWORK_PRESETS.some((p) => p.arkServerUrl === arkServerUrl.value && p.esploraUrl === esploraUrl.value),
);
const presetOptions = computed<ToggleOption<string>[]>(() =>
  NETWORK_PRESETS.map((p) => ({ value: p.arkServerUrl, label: p.displayName })),
);

function applyPreset(preset: NetworkPreset) {
  arkServerUrl.value = preset.arkServerUrl;
  esploraUrl.value = preset.esploraUrl;
  networkSaved.value = false;
}

function applyPresetByUrl(url: string) {
  const preset = NETWORK_PRESETS.find((p) => p.arkServerUrl === url);
  if (preset) applyPreset(preset);
}

onMounted(async () => {
  try {
    const settings = await client.getNetworkSettings();
    arkServerUrl.value = settings.arkServerUrl;
    esploraUrl.value = settings.esploraUrl;
  } catch (e: unknown) {
    networkError.value = String(e);
  } finally {
    networkLoading.value = false;
  }
});

async function saveNetwork() {
  networkSaving.value = true;
  networkError.value = '';
  networkSaved.value = false;
  try {
    await client.setNetworkSettings({
      arkServerUrl: arkServerUrl.value.trim(),
      esploraUrl: esploraUrl.value.trim(),
    });
    networkSaved.value = true;
  } catch (e: unknown) {
    networkError.value = String(e);
  } finally {
    networkSaving.value = false;
  }
}
</script>

<template>
  <section class="settings-view">
    <template v-if="networkLoading">
      <p class="hint">Loading…</p>
    </template>
    <template v-else>
      <ToggleGroup :options="presetOptions" :model-value="arkServerUrl" @update:model-value="applyPresetByUrl" />

      <p class="hint">
        Custom server URLs are also accepted below — the wallet asks the server directly whether it's mainnet or testnet, it doesn't guess from the URL.
      </p>
      <p v-if="!isKnownPresetPair" class="hint warning">
        Custom server: it can see the addresses and amounts you use, and could misreport fees or network status. It can never move funds without your approval — your keys never leave this device — but only point this at a server you trust.
      </p>

      <label>
        Ark server URL
        <input type="text" v-model="arkServerUrl" placeholder="https://mutinynet.arkade.sh" />
      </label>
      <label>
        Esplora (onchain) URL
        <input type="text" v-model="esploraUrl" placeholder="https://mutinynet.com/api" />
      </label>
      <p v-if="networkError" class="error">{{ networkError }}</p>
      <p v-if="networkSaved" class="success-hint">
        Saved and reconnected.
      </p>
      <button @click="saveNetwork" :disabled="networkSaving">
        {{ networkSaving ? 'Saving…' : 'Save network settings' }}
      </button>
    </template>

    <div class="faucets" v-if="!isMainnetSelected">
      <template v-if="activePreset?.network === 'mutinynet'">
        <p class="hint">
          Need mutinynet test coins? Send them to your boarding address
          (Receive tab) via:
        </p>
        <a href="https://faucet.mutinynet.com/" target="_blank" rel="noopener noreferrer">faucet.mutinynet.com</a>
        <p class="hint">
          If that's not working (it's gated by GitHub login with a daily limit), the
          <code>mutinynet-cli</code> tool (<code>cargo install mutinynet-cli</code>) hits the same faucet from the command line and gives clearer error output.
        </p>
      </template>
      <p v-else class="hint">
        This is a custom server URL, so there's no known faucet to link to here — check with whoever runs it.
      </p>
    </div>
  </section>
</template>

<style scoped>
.faucets {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}
.faucets a { color: var(--color-accent-secondary); font-size: 13px; text-decoration: none; }
.faucets a:hover { text-decoration: underline; }
</style>
