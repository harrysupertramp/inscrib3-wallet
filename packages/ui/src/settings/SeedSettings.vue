<script setup lang="ts">
import { ref } from 'vue';
import { useWalletClient } from '../wallet-client-key.js';
import { useCopyToClipboard } from '../composables/useCopyToClipboard.js';
import Icon from '../Icon.vue';

const client = useWalletClient();

const exportPassword = ref('');
const exportedMnemonic = ref('');
const exportLoading = ref(false);
const exportError = ref('');
const { copied: exportCopied, copy: copyExportedMnemonic } = useCopyToClipboard(2000, 30_000);

async function revealMnemonic() {
  exportError.value = '';
  exportedMnemonic.value = '';
  if (!exportPassword.value) return;
  exportLoading.value = true;
  try {
    exportedMnemonic.value = await client.exportMnemonic(exportPassword.value);
  } catch (e: unknown) {
    exportError.value = String(e).includes('WALLET_DATA_CORRUPTED')
      ? 'Your saved wallet data appears to be corrupted. This is not a password problem - retrying will not help.'
      : 'Incorrect password';
  } finally {
    exportLoading.value = false;
    exportPassword.value = '';
  }
}

function hideMnemonic() {
  exportedMnemonic.value = '';
  exportCopied.value = false;
}
</script>

<template>
  <section class="settings-view">
    <p class="hint warning">
      Anyone with your seed phrase can take everything in this wallet.
      Never share it, never paste it anywhere else.
    </p>

    <template v-if="!exportedMnemonic">
      <label>
        Password
        <input
          type="password"
          placeholder="Enter your password"
          v-model="exportPassword"
          @keydown.enter="revealMnemonic"
        />
      </label>
      <p v-if="exportError" class="error">{{ exportError }}</p>
      <button @click="revealMnemonic" :disabled="exportLoading || !exportPassword">
        {{ exportLoading ? 'Checking…' : 'Reveal seed phrase' }}
      </button>
    </template>

    <template v-else>
      <div class="mnemonic-display">
        <div class="mnemonic-words">
          <span class="word" v-for="(word, i) in exportedMnemonic.split(' ')" :key="i">
            <span class="num">{{ i + 1 }}.</span> {{ word }}
          </span>
        </div>
      </div>
      <button type="button" class="copy-btn" @click="copyExportedMnemonic(exportedMnemonic)">
        <Icon :name="exportCopied ? 'check' : 'copy'" :size="14" />
        {{ exportCopied ? 'Copied' : 'Copy to clipboard' }}
      </button>
      <p class="hint warning">
        Paste it somewhere safe, then clear your clipboard yourself — it is only wiped automatically if this window stays open for 30 seconds.
      </p>
      <button class="secondary" @click="hideMnemonic">Hide</button>
    </template>
  </section>
</template>

<style scoped>
.mnemonic-display {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 16px;
}
.mnemonic-words {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.word { font-size: 13px; font-family: monospace; }
.num { color: #555; margin-right: 4px; }
</style>
