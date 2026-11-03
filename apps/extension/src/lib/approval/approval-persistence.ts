// storage.session: survives a service-worker restart, not a browser restart.
const PENDING_REQUESTS_KEY = 'arkade:pending-approval-requests';

export interface PersistedApprovalRequest {
  method: string;
  params: unknown;
  origin: string;
  // The Ark server and account active when the request arrived.
  walletKey: string;
}

type PendingMap = Record<string, PersistedApprovalRequest>;

async function loadAll(): Promise<PendingMap> {
  const result = await browser.storage.session.get(PENDING_REQUESTS_KEY);
  return (result[PENDING_REQUESTS_KEY] as PendingMap) ?? {};
}

export async function savePendingRequest(approvalId: string, req: PersistedApprovalRequest): Promise<void> {
  const all = await loadAll();
  all[approvalId] = req;
  await browser.storage.session.set({ [PENDING_REQUESTS_KEY]: all });
}

export async function loadPendingRequest(approvalId: string): Promise<PersistedApprovalRequest | undefined> {
  const all = await loadAll();
  return all[approvalId];
}

export async function clearPendingRequest(approvalId: string): Promise<void> {
  const all = await loadAll();
  delete all[approvalId];
  await browser.storage.session.set({ [PENDING_REQUESTS_KEY]: all });
}
