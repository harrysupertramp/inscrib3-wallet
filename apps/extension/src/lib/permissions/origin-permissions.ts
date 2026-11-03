const STORAGE_KEY = 'arkade:permissions:origins';

type ConnectedOrigins = Record<string, { connectedAt: number }>;

async function load(): Promise<ConnectedOrigins> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as ConnectedOrigins) ?? {};
}

async function save(origins: ConnectedOrigins): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: origins });
}

export async function isConnected(origin: string): Promise<boolean> {
  const origins = await load();
  return origin in origins;
}

export async function connect(origin: string): Promise<void> {
  const origins = await load();
  origins[origin] = { connectedAt: Date.now() };
  await save(origins);
}

export async function revoke(origin: string): Promise<void> {
  const origins = await load();
  delete origins[origin];
  await save(origins);
}

export async function getConnectedOrigins(): Promise<string[]> {
  const origins = await load();
  return Object.keys(origins);
}
