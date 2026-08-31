import type { NotebookAction } from "@/scopes/injects/notebook/apiClient";

const channel = "nlm-transcript-page-api";
const token = typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  progress: (stage: string, detail?: Record<string, unknown>) => void;
  timer: number;
};

const pending = new Map<string, PendingRequest>();
let bridgeReady = false;
const bridgeWaiters = new Set<() => void>();

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || message.channel !== channel || message.token !== token || message.target !== "content") return;
  if (message.type === "ready") {
    bridgeReady = true;
    bridgeWaiters.forEach((resolve) => resolve());
    bridgeWaiters.clear();
    return;
  }
  const request = pending.get(message.requestId);
  if (!request) return;
  if (message.type === "progress") {
    request.progress(String(message.stage || ""), message.detail);
    return;
  }
  if (message.type !== "response") return;
  pending.delete(message.requestId);
  clearTimeout(request.timer);
  if (message.ok) request.resolve(message.result);
  else request.reject(new Error(String(message.error || "NotebookLM 页面请求失败。")));
});

export function callNotebookPageApi(
  action: NotebookAction,
  payload: Record<string, any>,
  progress: PendingRequest["progress"],
  timeoutMs: number
): Promise<any> {
  const requestId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return waitForPageBridge().then(() => new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("NotebookLM 页面请求超时，请确认页面已完整加载。"));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, progress, timer });
    window.postMessage({
      channel,
      token,
      source: "content",
      target: "page",
      type: "request",
      requestId,
      action,
      payload
    }, window.location.origin);
  }));
}

function waitForPageBridge(timeoutMs = 5000): Promise<void> {
  if (bridgeReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let pingTimer = 0;
    const finish = () => {
      clearInterval(pingTimer);
      clearTimeout(timeoutTimer);
      bridgeWaiters.delete(onReady);
    };
    const onReady = () => {
      finish();
      resolve();
    };
    const ping = () => window.postMessage({
      channel,
      token,
      source: "content",
      target: "page",
      type: "ping"
    }, window.location.origin);
    const timeoutTimer = window.setTimeout(() => {
      finish();
      reject(new Error("NotebookLM 页面桥未加载。请重新加载扩展并刷新当前笔记本页面。"));
    }, timeoutMs);
    bridgeWaiters.add(onReady);
    ping();
    pingTimer = window.setInterval(ping, 300);
  });
}
