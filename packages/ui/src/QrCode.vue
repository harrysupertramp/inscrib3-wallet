<script setup lang="ts">
import { ref, watch } from 'vue';
import QRCode from 'qrcode';

const props = withDefaults(defineProps<{ value: string; size?: number }>(), { size: 180 });

const dataUrl = ref('');

async function render() {
  if (!props.value) {
    dataUrl.value = '';
    return;
  }
  try {
    // Always black on white: scanners need the contrast.
    dataUrl.value = await QRCode.toDataURL(props.value, {
      width: props.size,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch {
    dataUrl.value = '';
  }
}

watch(() => props.value, render, { immediate: true });
</script>

<template>
  <img v-if="dataUrl" :src="dataUrl" :width="size" :height="size" class="qr-code" alt="QR code" />
</template>

<style scoped>
.qr-code {
  display: block;
  margin: 0 auto;
  background: #ffffff;
  border-radius: 8px;
  padding: 8px;
}
</style>
