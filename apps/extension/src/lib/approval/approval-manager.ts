// One popup window per approval request; closing the window rejects it.
// Pending promises live in memory, so background-router recovers answers
// after a service-worker restart from approval-persistence.ts.

export type ApprovalType =
  | 'connect'
  | 'sendToAddress'
  | 'sendAsset'
  | 'settle'
  | 'signMessage';

export interface ApprovalRequest {
  type: ApprovalType;
  origin: string;
  address?: string;
  amount?: number;
  assets?: Array<{ assetId: string; amount: number }>;
  message?: string;
  // Which wallet would act, so mainnet and testnet requests look different.
  network?: string;
  account?: string;
}

interface PendingApproval {
  origin: string;
  resolve: (approved: boolean) => void;
  onWindowRemoved: (closedWindowId: number) => void;
}

const pending = new Map<string, PendingApproval>();
let _counter = 0;

export function nextApprovalId(): string {
  return `approval-${Date.now()}-${++_counter}`;
}

// Limits stacked popups from a spammy dApp (approval fatigue).
const MAX_PENDING_APPROVALS_PER_ORIGIN = 3;

// Counted before any await; counting `pending` would let concurrent calls
// all pass the cap.
const pendingCountByOrigin = new Map<string, number>();

function incrementPendingCount(origin: string): number {
  const count = (pendingCountByOrigin.get(origin) ?? 0) + 1;
  pendingCountByOrigin.set(origin, count);
  return count;
}

function decrementPendingCount(origin: string): void {
  const count = (pendingCountByOrigin.get(origin) ?? 1) - 1;
  if (count <= 0) pendingCountByOrigin.delete(origin);
  else pendingCountByOrigin.set(origin, count);
}

export async function requestApproval(approvalId: string, req: ApprovalRequest): Promise<boolean> {
  if (incrementPendingCount(req.origin) > MAX_PENDING_APPROVALS_PER_ORIGIN) {
    decrementPendingCount(req.origin);
    return false;
  }

  const params = new URLSearchParams({ id: approvalId, type: req.type, origin: req.origin });
  if (req.address) params.set('address', req.address);
  if (req.amount !== undefined) params.set('amount', String(req.amount));
  if (req.assets) params.set('assets', JSON.stringify(req.assets));
  if (req.message !== undefined) params.set('message', req.message);
  if (req.network) params.set('network', req.network);
  if (req.account) params.set('account', req.account);

  let windowId: number | undefined;
  try {
    const win = await browser.windows.create({
      url: browser.runtime.getURL(`/approval.html?${params.toString()}`),
      type: 'popup',
      width: 400,
      height: 480,
    });
    windowId = win?.id;
  } catch (e) {
    decrementPendingCount(req.origin);
    throw e;
  }
  if (windowId === undefined) {
    decrementPendingCount(req.origin);
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const onWindowRemoved = (closedWindowId: number) => {
      if (closedWindowId === windowId) finish(approvalId, false);
    };
    browser.windows.onRemoved.addListener(onWindowRemoved);
    pending.set(approvalId, { origin: req.origin, resolve, onWindowRemoved });
  });
}

// false when the request is gone (service-worker restart), so the caller
// can report it instead of claiming success.
export function resolveApproval(approvalId: string, approved: boolean): boolean {
  return finish(approvalId, approved);
}

function finish(approvalId: string, approved: boolean): boolean {
  const entry = pending.get(approvalId);
  if (!entry) return false;
  pending.delete(approvalId);
  decrementPendingCount(entry.origin);
  browser.windows.onRemoved.removeListener(entry.onWindowRemoved);
  entry.resolve(approved);
  return true;
}
