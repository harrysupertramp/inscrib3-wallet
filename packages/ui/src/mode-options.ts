import type { ToggleOption } from './ToggleGroup.vue';

// Arkade receive methods. 'unified' is one QR carrying both the boarding and
// the Ark address; the others show a single method.
export type ReceiveMode = 'unified' | 'ark' | 'onchain' | 'lightning';

export const RECEIVE_MODE_OPTIONS: ToggleOption<ReceiveMode>[] = [
  { value: 'unified', label: 'Unified' },
  { value: 'ark', label: 'Ark' },
  { value: 'onchain', label: 'Boarding' },
  { value: 'lightning', label: 'Lightning' },
];
