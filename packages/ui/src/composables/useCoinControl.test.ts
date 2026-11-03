import { describe, expect, test } from 'bun:test';
import { useCoinControl } from './useCoinControl.js';

const coin = (txid: string, vout: number, value: number) => ({ txid, vout, value });

function setup(list: Array<ReturnType<typeof coin>>) {
  let loads = 0;
  const picker = useCoinControl(async () => {
    loads++;
    return list;
  });
  return { picker, loads: () => loads };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('useCoinControl', () => {
  test('no selection means automatic coin selection', () => {
    const { picker } = setup([]);
    expect(picker.chosenOutpoints()).toBeUndefined();
  });

  test('checked coins become outpoints and a total', async () => {
    const { picker } = setup([coin('a', 0, 1000), coin('b', 1, 500)]);
    picker.toggleCoinControl();
    await tick();
    picker.toggleCoinSelected(picker.coins.value[1]);
    expect(picker.selectedTotal.value).toBe(500);
    expect(picker.chosenOutpoints()).toEqual([{ txid: 'b', vout: 1 }]);
  });

  test('bigint coin values add up too', async () => {
    const picker = useCoinControl(async () => [{ txid: 'a', vout: 0, value: 700n }]);
    picker.toggleCoinControl();
    await tick();
    picker.toggleCoinSelected(picker.coins.value[0]);
    expect(picker.selectedTotal.value).toBe(700);
  });

  // Regression: the list loaded only when empty, so coins spent since the
  // first open were still offered.
  test('every open reloads the list', async () => {
    const { picker, loads } = setup([coin('a', 0, 1000)]);
    picker.toggleCoinControl();
    await tick();
    picker.toggleCoinControl();
    picker.toggleCoinControl();
    await tick();
    expect(loads()).toBe(2);
  });

  test('closing the picker drops back to automatic selection', async () => {
    const { picker } = setup([coin('a', 0, 1000)]);
    picker.toggleCoinControl();
    await tick();
    picker.toggleCoinSelected(picker.coins.value[0]);
    picker.toggleCoinControl();
    expect(picker.chosenOutpoints()).toBeUndefined();
  });

  test('a stale selection is cleared and the list reloaded', async () => {
    const { picker, loads } = setup([coin('a', 0, 1000)]);
    picker.toggleCoinControl();
    await tick();
    picker.toggleCoinSelected(picker.coins.value[0]);
    picker.onSelectionStale();
    await tick();
    expect(picker.selectedOutpoints.value.size).toBe(0);
    expect(loads()).toBe(2);
  });
});
