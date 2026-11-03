import { createApp } from 'vue';
import { WalletApp, WALLET_CLIENT_KEY } from '@inscrib3/ui';
import { createExtensionWalletClient } from '../../src/lib/wallet/extension-wallet-client.js';
import VersionBanner from '../../src/lib/wallet/VersionBanner.vue';

const app = createApp(WalletApp);
app.provide(WALLET_CLIENT_KEY, createExtensionWalletClient());
app.mount('#app');

createApp(VersionBanner).mount('#version-banner');

export default app;
