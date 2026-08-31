import {
  isValidColabSessionId,
  type ColabRuntimeSnapshot
} from "@/lib/colabRuntime";

const storageKey = "nlmColabRuntime";
let startLock: Promise<unknown> | null = null;
let storageMutation: Promise<void> = Promise.resolve();

export async function readColabRuntime(): Promise<ColabRuntimeSnapshot | null> {
  const stored = (await chrome.storage.session.get(storageKey))[storageKey];
  return isColabRuntimeSnapshot(stored) ? stored : null;
}

export async function writeColabRuntime(snapshot: ColabRuntimeSnapshot): Promise<void> {
  await enqueueStorageMutation(async () => {
    await chrome.storage.session.set({ [storageKey]: snapshot });
  });
}

export async function updateColabRuntime(
  update: (current: ColabRuntimeSnapshot | null) => ColabRuntimeSnapshot | null
): Promise<ColabRuntimeSnapshot | null> {
  return enqueueStorageMutation(async () => {
    const next = update(await readColabRuntime());
    if (next) await chrome.storage.session.set({ [storageKey]: next });
    else await chrome.storage.session.remove(storageKey);
    return next;
  });
}

export async function clearColabRuntimeForTab(tabId: number): Promise<void> {
  await updateColabRuntime((current) => current?.tabId === tabId ? null : current);
}

export function withColabStartLock<T>(operation: () => Promise<T>): Promise<T> {
  if (startLock) return startLock as Promise<T>;
  const pending = operation().finally(() => {
    if (startLock === pending) startLock = null;
  });
  startLock = pending;
  return pending;
}

function enqueueStorageMutation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = storageMutation.then(operation, operation);
  storageMutation = pending.then(() => undefined, () => undefined);
  return pending;
}

function isColabRuntimeSnapshot(value: unknown): value is ColabRuntimeSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return Number.isSafeInteger(snapshot.tabId)
    && Number(snapshot.tabId) >= 0
    && isValidColabSessionId(snapshot.sessionId)
    && ["stopped", "starting", "ready", "stale", "failed"].includes(String(snapshot.state))
    && Number.isFinite(snapshot.startedAt)
    && Number.isFinite(snapshot.lastSeenAt);
}
