<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AccountInfo } from '@inscrib3/core';
import { useWalletClient } from '../wallet-client-key.js';
import { useAccounts } from '../composables/useWalletState.js';

const client = useWalletClient();

const {
  accounts,
  active,
  loading: accountsLoading,
  error: accountsError,
  refresh: refreshAccounts,
} = useAccounts();

onMounted(refreshAccounts);

function isActive(acc: AccountInfo): boolean {
  return acc.seedId === active.value.seedId && acc.index === active.value.index;
}

// Display only; grouping uses the raw seedId. Avoids printing "NaN".
function seedLabel(seedId: number): number {
  return Number.isFinite(seedId) ? seedId : 0;
}

const groupedAccounts = computed(() => {
  const bySeed = new Map<number, AccountInfo[]>();
  for (const acc of accounts.value) {
    if (!bySeed.has(acc.seedId)) bySeed.set(acc.seedId, []);
    bySeed.get(acc.seedId)!.push(acc);
  }
  return [...bySeed.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seedId, accts]) => ({ seedId, accounts: [...accts].sort((a, b) => a.index - b.index) }));
});

const renaming = ref<{ seedId: number; index: number } | null>(null);
const renameLabel = ref('');

function startRename(acc: AccountInfo) {
  renaming.value = { seedId: acc.seedId, index: acc.index };
  renameLabel.value = acc.label;
}

function cancelRename() {
  renaming.value = null;
}

async function confirmRename() {
  if (!renaming.value || !renameLabel.value.trim()) return;
  try {
    await client.renameAccount(renaming.value.seedId, renaming.value.index, renameLabel.value);
    renaming.value = null;
    await refreshAccounts();
  } catch (e: unknown) {
    accountsError.value = String(e);
  }
}

// Hides the account only; seed and funds are untouched.
const removing = ref<{ seedId: number; index: number } | null>(null);
const removeLoading = ref(false);

function startRemove(acc: AccountInfo) {
  removing.value = { seedId: acc.seedId, index: acc.index };
  accountsError.value = '';
}

function cancelRemove() {
  removing.value = null;
}

async function confirmRemove() {
  if (!removing.value) return;
  removeLoading.value = true;
  try {
    await client.removeAccount(removing.value.seedId, removing.value.index);
    removing.value = null;
    await refreshAccounts();
  } catch (e: unknown) {
    accountsError.value = String(e);
  } finally {
    removeLoading.value = false;
  }
}

const switchingTo = ref<{ seedId: number; index: number } | null>(null);
const switchError = ref('');

function isSwitching(acc: AccountInfo): boolean {
  return switchingTo.value?.seedId === acc.seedId && switchingTo.value?.index === acc.index;
}

async function switchTo(seedId: number, accountIndex: number) {
  switchingTo.value = { seedId, index: accountIndex };
  switchError.value = '';
  try {
    await client.switchAccount(seedId, accountIndex);
    await refreshAccounts();
  } catch (e: unknown) {
    switchError.value = String(e).includes('SERVER_UNREACHABLE') ? 'Could not reach the Ark server - try again' : String(e);
  } finally {
    switchingTo.value = null;
  }
}

const addingAccount = ref(false);
const newAccountLabel = ref('');
const addAccountLoading = ref(false);
const addAccountError = ref('');

function startAddAccount() {
  addingAccount.value = true;
  newAccountLabel.value = '';
  addAccountError.value = '';
}

function cancelAddAccount() {
  addingAccount.value = false;
}

async function confirmAddAccount() {
  addAccountLoading.value = true;
  addAccountError.value = '';
  try {
    await client.addAccount(newAccountLabel.value || undefined);
    addingAccount.value = false;
    await refreshAccounts();
  } catch (e: unknown) {
    const msg = String(e);
    addAccountError.value = msg.includes('SERVER_UNREACHABLE') ? 'Could not reach the Ark server - try again' : msg;
  } finally {
    addAccountLoading.value = false;
  }
}

const importingSeed = ref(false);
const importMnemonic = ref('');
const importLabel = ref('');
const importLoading = ref(false);
const importError = ref('');

function startImportSeed() {
  importingSeed.value = true;
  importMnemonic.value = '';
  importLabel.value = '';
  importError.value = '';
}

function cancelImportSeed() {
  importingSeed.value = false;
}

async function confirmImportSeed() {
  if (!importMnemonic.value.trim()) {
    importError.value = 'Seed phrase is required';
    return;
  }
  importLoading.value = true;
  importError.value = '';
  try {
    await client.importSeed(importMnemonic.value.trim(), importLabel.value || undefined);
    importingSeed.value = false;
    await refreshAccounts();
  } catch (e: unknown) {
    const msg = String(e);
    importError.value = msg.includes('SERVER_UNREACHABLE') ? 'Could not reach the Ark server - try again' : msg;
  } finally {
    importLoading.value = false;
  }
}
</script>

<template>
  <section class="settings-view">
    <p class="hint">Separate accounts, either derived from the same seed phrase or imported from an independent one. Each shows its BIP86 key path, to restore it in another wallet.</p>

    <p v-if="accountsLoading" class="hint">Loading…</p>
    <p v-else-if="accountsError" class="error">{{ accountsError }}</p>
    <div v-else class="seed-groups">
      <div class="seed-group" v-for="group in groupedAccounts" :key="group.seedId">
        <p class="seed-group-label">
          Seed {{ seedLabel(group.seedId) }}<span v-if="group.seedId === 0" class="hint"> (original)</span>
        </p>
        <div class="origin-list">
          <div class="origin-row" v-for="acc in group.accounts" :key="`${acc.seedId}-${acc.index}`">
            <template v-if="renaming && renaming.seedId === acc.seedId && renaming.index === acc.index">
              <input type="text" v-model="renameLabel" @keydown.enter="confirmRename" @keydown.esc="cancelRename" />
              <div class="account-actions">
                <button type="button" class="secondary revoke-btn" @click="confirmRename">Save</button>
                <button type="button" class="secondary revoke-btn" @click="cancelRename">Cancel</button>
              </div>
            </template>
            <template v-else-if="removing && removing.seedId === acc.seedId && removing.index === acc.index">
              <span class="account-label">Remove "{{ acc.label }}"?</span>
              <div class="account-actions">
                <button type="button" class="danger revoke-btn" @click="confirmRemove" :disabled="removeLoading">
                  {{ removeLoading ? 'Removing…' : 'Yes, remove' }}
                </button>
                <button type="button" class="secondary revoke-btn" @click="cancelRemove" :disabled="removeLoading">Cancel</button>
              </div>
            </template>
            <template v-else>
              <span class="account-label">
                {{ acc.label }}
                <span v-if="acc.derivationPath" class="account-path">{{ acc.derivationPath }}</span>
              </span>
              <div class="account-actions">
                <span v-if="isActive(acc)" class="success-hint">Active</span>
                <button
                  v-else
                  type="button"
                  class="secondary revoke-btn"
                  :disabled="switchingTo !== null"
                  @click="switchTo(acc.seedId, acc.index)"
                >
                  {{ isSwitching(acc) ? 'Switching…' : 'Switch' }}
                </button>
                <button type="button" class="secondary revoke-btn" :disabled="switchingTo !== null" @click="startRename(acc)">
                  Rename
                </button>
                <button
                  v-if="!isActive(acc) && accounts.length > 1"
                  type="button"
                  class="danger revoke-btn"
                  :disabled="switchingTo !== null"
                  @click="startRemove(acc)"
                >
                  Remove
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
    <p v-if="switchError" class="error">{{ switchError }}</p>

    <p class="hint">Adds a new account under Seed {{ seedLabel(active.seedId) }} — the seed you're currently using.</p>
    <template v-if="addingAccount">
      <label>
        Label (optional)
        <input type="text" v-model="newAccountLabel" placeholder="e.g. Savings" @keydown.enter="confirmAddAccount" />
      </label>
      <p v-if="addAccountError" class="error">{{ addAccountError }}</p>
      <button type="button" @click="confirmAddAccount" :disabled="addAccountLoading">
        {{ addAccountLoading ? 'Adding…' : 'Add account' }}
      </button>
      <button type="button" class="secondary" @click="cancelAddAccount" :disabled="addAccountLoading">Cancel</button>
    </template>
    <button v-else type="button" class="secondary" @click="startAddAccount">+ Add account</button>

    <template v-if="importingSeed">
      <label>
        Seed phrase
        <textarea
          rows="3"
          class="seed-input"
          placeholder="Enter your 12 or 24 word seed phrase"
          v-model="importMnemonic"
          spellcheck="false"
          autocomplete="off"
        ></textarea>
      </label>
      <label>
        Label (optional)
        <input type="text" v-model="importLabel" placeholder="e.g. Savings" />
      </label>
      <p class="hint warning">
        Anyone with this phrase can access the funds it controls. Never share it, never paste it anywhere else.
      </p>
      <p v-if="importError" class="error">{{ importError }}</p>
      <button type="button" @click="confirmImportSeed" :disabled="importLoading">
        {{ importLoading ? 'Importing…' : 'Import seed phrase' }}
      </button>
      <button type="button" class="secondary" @click="cancelImportSeed" :disabled="importLoading">Cancel</button>
    </template>
    <button v-else type="button" class="secondary" @click="startImportSeed">+ Import a different seed phrase</button>
  </section>
</template>

<style scoped>
.seed-input {
  font-family: monospace;
  line-height: 1.6;
  letter-spacing: 0.02em;
}
.seed-input:focus { border-color: #e0a030; }
.seed-groups { display: flex; flex-direction: column; gap: 16px; }
.seed-group-label { font-size: 12px; font-weight: 600; color: var(--color-text-muted); margin-bottom: 6px; }
.account-label { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--color-text); word-break: break-word; }
.account-path { display: block; margin-top: 2px; font-family: monospace; font-size: 11px; color: var(--color-text-muted); }
.account-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
</style>
