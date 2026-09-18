export const WORKSPACE_ROUTE_MISMATCH = "记录与当前笔记本不匹配。";

function notebookOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && ["notebook.google.com", "notebooklm.google.com"].includes(url.hostname)) return url.origin;
  } catch { /* Invalid URLs fail closed. */ }
}

// sender.url can retain the document's original URL after an SPA navigation.
// Trust its origin, but compare the requested notebook with the live top-level tab.
export function validateWorkspaceAccess(sender: { url?: string; frameId?: number }, liveUrl: string | undefined, notebookId: string): void {
  const origin = notebookOrigin(sender.url || "");
  if (sender.frameId !== 0 || !origin || notebookOrigin(liveUrl || "") !== origin) throw new Error("记录请求来源无效。");
  if (!/^[0-9a-f-]+$/i.test(notebookId) || new URL(liveUrl!).pathname.replace(/\/$/, "") !== `/notebook/${notebookId}`) {
    throw new Error(WORKSPACE_ROUTE_MISMATCH);
  }
}

// Only retry a read during a route transition, never replay mutations.
export async function loadWorkspaceWhenCurrent(load: () => Promise<void>, current: () => boolean,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!current()) return false;
    try { await load(); return current(); }
    catch (error) {
      if (!current()) return false;
      if (!(error instanceof Error) || error.message !== WORKSPACE_ROUTE_MISMATCH || attempt === 3) throw error;
      await wait(350 * (attempt + 1));
    }
  }
  return false;
}
