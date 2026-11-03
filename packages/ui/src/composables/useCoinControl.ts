import { computed, ref, type Ref } from 'vue';
import type { VtxoOutpoint } from '@inscrib3/core';

interface Coin {
  txid: string;
  vout: number;
  value: number | bigint;
}

export function coinKey(c: { txid: string; vout: number }): string {
  return `${c.txid}:${c.vout}`;
}

// Picker for spending specific coins: whatever Ark VTXOs
// `load` returns. A selection only applies while the picker is open and
// something is checked; otherwise coins are picked automatically. The list
// reloads on every open, so a coin spent since is never offered.
export function useCoinControl<T extends Coin>(load: () => Promise<T[]>) {
  const showCoinControl = ref(false);
  const coins = ref([]) as Ref<T[]>;
  const coinsLoading = ref(false);
  const coinsError = ref('');
  const selectedOutpoints = ref<Set<string>>(new Set());

  async function loadCoins() {
    if (coinsLoading.value) return;
    coinsLoading.value = true;
    coinsError.value = '';
    try {
      coins.value = await load();
    } catch (e: unknown) {
      coinsError.value = String(e);
    } finally {
      coinsLoading.value = false;
    }
  }

  function toggleCoinControl() {
    showCoinControl.value = !showCoinControl.value;
    if (showCoinControl.value) void loadCoins();
  }

  function toggleCoinSelected(c: T) {
    const key = coinKey(c);
    const next = new Set(selectedOutpoints.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selectedOutpoints.value = next;
  }

  function resetCoinControl() {
    showCoinControl.value = false;
    selectedOutpoints.value = new Set();
  }

  const selectedCoins = computed(() => coins.value.filter((c) => selectedOutpoints.value.has(coinKey(c))));
  const selectedTotal = computed(() => selectedCoins.value.reduce((sum, c) => sum + Number(c.value), 0));
  const coinControlActive = computed(() => showCoinControl.value && selectedOutpoints.value.size > 0);

  // What to pass to a send call: undefined means automatic selection.
  function chosenOutpoints(): VtxoOutpoint[] | undefined {
    if (!coinControlActive.value) return undefined;
    return [...selectedOutpoints.value].map((key) => {
      const [txid, vout] = key.split(':');
      return { txid, vout: Number(vout) };
    });
  }

  // A selected coin was spent or locked meanwhile: clear and reload the list.
  function onSelectionStale() {
    selectedOutpoints.value = new Set();
    void loadCoins();
  }

  return {
    showCoinControl,
    coins,
    coinsLoading,
    coinsError,
    selectedOutpoints,
    selectedCoins,
    selectedTotal,
    coinControlActive,
    loadCoins,
    toggleCoinControl,
    toggleCoinSelected,
    resetCoinControl,
    chosenOutpoints,
    onSelectionStale,
  };
}
