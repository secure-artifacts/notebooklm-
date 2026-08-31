import { sheetSettingsStorageKey } from "@/const";
import {
  isColabStartupExpired,
  isColabRuntimeStale,
  isValidColabSessionId,
  runtimeStateLabel,
  type ColabRuntimeSnapshot
} from "@/lib/colabRuntime";
import { decodeColabControlValue } from "@/lib/colabProvider";
import { schema, type SchemaType } from "@/schema";
import type { ColabApiRequest, SheetUpsertRequest } from "@/types/messages";
import { useStorageLocal } from "@webextkits/storage-local";
import { callColabControl } from "./colabService";
import {
  clearColabRuntimeForTab,
  readColabRuntime,
  updateColabRuntime,
  withColabStartLock,
  writeColabRuntime
} from "./colabRuntimeManager";
import { upsertSheetRecords } from "./sheetService";
import {
  clearFacebookJob,
  loadFacebookJob,
  saveFacebookJob,
  updateFacebookJobProgress,
  updateFacebookJobActiveSources
} from "./facebookJobStore";

const runtimeChannel = "nlm-transcript-background";
const storage = useStorageLocal<SchemaType>(schema);
const colabSessionEvents = new Map<string, { event: unknown; receivedAt: number }>();
const COLAB_SESSION_EVENT_TTL_MS = 5 * 60 * 1000;

type RuntimeRequest = {
  channel?: string;
  action?: string;
  payload?: any;
};

export function registerMessages(): void {
  chrome.runtime.onMessage.addListener((request: RuntimeRequest, sender, sendResponse) => {
    if (request?.channel !== runtimeChannel) return;
    handleRuntimeRequest(request.action, request.payload, sender)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearColabRuntimeForTab(tabId);
  });
}

async function handleRuntimeRequest(action: string | undefined, payload: any, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (action === "upsertSheet") return handleSheetUpsert(payload as SheetUpsertRequest);
  if (action === "loadFacebookJob") {
    if (!isNotebookSender(sender)) throw new Error("Facebook 任务查询来源无效。");
    return loadFacebookJob(String(payload?.notebookId || ""));
  }
  if (action === "saveFacebookJob") {
    if (!isNotebookSender(sender)) throw new Error("Facebook 任务保存来源无效。");
    await saveFacebookJob(payload?.job);
    return { saved: true };
  }
  if (action === "updateFacebookJobActiveSources") {
    if (!isNotebookSender(sender)) throw new Error("Facebook 活动批次保存来源无效。");
    await updateFacebookJobActiveSources(
      String(payload?.notebookId || ""),
      Number(payload?.activeBatchStart),
      Array.isArray(payload?.activeSourceIds) ? payload.activeSourceIds.map(String) : []
    );
    return { saved: true };
  }
  if (action === "updateFacebookJobProgress") {
    if (!isNotebookSender(sender)) throw new Error("Facebook 任务进度保存来源无效。");
    await updateFacebookJobProgress(payload?.progress);
    return { saved: true };
  }
  if (action === "clearFacebookJob") {
    if (!isNotebookSender(sender)) throw new Error("Facebook 任务清除来源无效。");
    await clearFacebookJob(String(payload?.notebookId || ""));
    return { cleared: true };
  }
  if (action === "callColab") {
    if (!isNotebookSender(sender)) throw new Error("Colab 控制请求来源无效。");
    return callColabControl(payload as ColabApiRequest);
  }
  if (action === "getColabSessionEvent") {
    if (!isNotebookSender(sender)) throw new Error("Colab 会话查询来源无效。");
    return getColabSessionEvent(payload);
  }
  if (action === "findReusableColabRuntime") {
    if (!isNotebookSender(sender)) throw new Error("Colab 运行时查询来源无效。");
    return findReusableColabRuntime();
  }
  if (action === "startColabRuntime") {
    if (!isExtensionPageSender(sender)) throw new Error("Colab 启动请求来源无效。");
    return startSingletonColabRuntime();
  }
  if (action === "getColabRuntimeStatus") {
    if (!isExtensionPageSender(sender)) throw new Error("Colab 状态查询来源无效。");
    return getColabRuntimeStatus();
  }
  if (action === "relayColabEvent") return relayColabEvent(payload, sender);
  if (action === "relayColabFrameEvent") return relayColabFrameEvent(payload, sender);
  throw new Error("不支持的扩展后台请求。");
}

async function startSingletonColabRuntime(): Promise<{ tabId: number; ready: boolean; restarted: boolean; state: string }> {
  return withColabStartLock(startSingletonColabRuntimeUnlocked);
}

async function startSingletonColabRuntimeUnlocked(): Promise<{ tabId: number; ready: boolean; restarted: boolean; state: string }> {
  const [stored, helperTabs] = await Promise.all([readColabRuntime(), findColabHelperTabs()]);
  const target = findPreferredHelperTab(helperTabs, stored);
  const now = Date.now();

  if (target?.id !== undefined) {
    const runtime = await queryColabTab(target.id);
    const sessionId = String(runtime?.sessionId || getColabSessionId(target.url));
    const startedAt = Number(runtime?.startedAt) || stored?.startedAt || now;
    if (isValidColabSessionId(sessionId)) {
      if (runtime?.event && await isHealthyControlEvent(runtime.event, sessionId)) {
        await writeColabRuntime({ tabId: target.id, sessionId, state: "ready", startedAt, lastSeenAt: now });
        await focusTab(target.id, target.windowId);
        await closeDuplicateColabTabs(helperTabs, target.id);
        return { tabId: target.id, ready: true, restarted: false, state: "ready" };
      }
      const snapshot: ColabRuntimeSnapshot = {
        tabId: target.id,
        sessionId,
        state: runtime?.state === "failed" ? "failed" : "starting",
        startedAt,
        lastSeenAt: now
      };
      const contentIsStarting = runtime?.state === "starting" || target.status === "loading";
      if (!isColabStartupExpired(snapshot) && snapshot.state === "starting" && contentIsStarting) {
        await writeColabRuntime(snapshot);
        await focusTab(target.id, target.windowId);
        await closeDuplicateColabTabs(helperTabs, target.id);
        return { tabId: target.id, ready: false, restarted: false, state: "starting" };
      }
    }
  }

  const sessionId = `nlm-${crypto.randomUUID().replace(/-/gu, "")}`;
  const url = new URL("https://colab.research.google.com/notebooks/empty.ipynb");
  url.searchParams.set("nlm_session", sessionId);
  url.searchParams.set("hl", "zh-CN");
  const opened = target?.id !== undefined
    ? await chrome.tabs.update(target.id, { url: url.toString(), active: true })
    : await chrome.tabs.create({ url: url.toString(), active: true });
  if (!opened || opened.id === undefined) throw new Error("无法创建 Colab 临时后端标签页。");
  if (opened.windowId !== undefined) await chrome.windows.update(opened.windowId, { focused: true }).catch(() => undefined);
  await writeColabRuntime({
    tabId: opened.id,
    sessionId,
    state: "starting",
    startedAt: now,
    lastSeenAt: now
  });
  await closeDuplicateColabTabs(helperTabs, opened.id);
  return { tabId: opened.id, ready: false, restarted: Boolean(target), state: "starting" };
}

async function queryColabTab(tabId: number): Promise<any | null> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { channel: "nlm-colab-runtime-query" });
    const sessionId = String(response?.sessionId || "");
    if (!isValidColabSessionId(sessionId)) return null;
    return response;
  } catch {
    return null;
  }
}

async function focusTab(tabId: number, windowId?: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
  if (windowId !== undefined) await chrome.windows.update(windowId, { focused: true }).catch(() => undefined);
}

async function closeDuplicateColabTabs(tabs: chrome.tabs.Tab[], keepTabId: number): Promise<void> {
  const duplicateIds = tabs.filter((tab) => tab.id !== undefined && tab.id !== keepTabId).map((tab) => tab.id!);
  if (duplicateIds.length) await chrome.tabs.remove(duplicateIds).catch(() => undefined);
}

function getColabSessionId(value: string | undefined): string {
  try {
    const url = new URL(String(value || ""));
    const sessionId = url.searchParams.get("nlm_session") || "";
    return isValidColabSessionId(sessionId) ? sessionId : "";
  } catch {
    return "";
  }
}

async function findReusableColabRuntime(): Promise<unknown> {
  const [stored, tabs] = await Promise.all([readColabRuntime(), findColabHelperTabs()]);
  const ordered = orderHelperTabs(tabs, stored);
  for (const tab of ordered) {
    if (tab.id === undefined) continue;
    const response = await queryColabTab(tab.id);
    const sessionId = String(response?.sessionId || "");
    const event = response?.event;
    if (event?.type !== "control" || event.session_id !== sessionId) continue;
    if (typeof event.base_url !== "string" || typeof event.token !== "string") continue;
    if (!await isHealthyControlEvent(event, sessionId)) {
      await writeColabRuntime({
        tabId: tab.id,
        sessionId,
        state: "stale",
        startedAt: Number(response?.startedAt) || stored?.startedAt || Date.now(),
        lastSeenAt: Date.now(),
        error: "Colab 控制通道健康检查失败。"
      });
      return null;
    }
    await writeColabRuntime({
      tabId: tab.id,
      sessionId,
      state: "ready",
      startedAt: Number(response?.startedAt) || stored?.startedAt || Date.now(),
      lastSeenAt: Date.now()
    });
    return event;
  }
  if (stored) {
    await updateColabRuntime((current) => current ? { ...current, state: "stale", error: "Colab 标签或控制通道不可用。" } : null);
  }
  return null;
}

async function getColabRuntimeStatus(): Promise<{ state: string; label: string; tabId?: number; error?: string }> {
  const stored = await readColabRuntime();
  if (!stored) return { state: "stopped", label: runtimeStateLabel("stopped") };
  try {
    await chrome.tabs.get(stored.tabId);
    const response = await queryColabTab(stored.tabId);
    if (response?.event?.type === "control" && response.event.session_id === stored.sessionId) {
      const ready = { ...stored, state: "ready" as const, lastSeenAt: Date.now(), error: undefined };
      await writeColabRuntime(ready);
      return { state: ready.state, label: runtimeStateLabel(ready.state), tabId: ready.tabId };
    }
    const starting = { ...stored, state: "starting" as const, lastSeenAt: Date.now() };
    if (stored.state === "starting" && response?.state !== "failed" && !isColabStartupExpired(starting)) {
      await writeColabRuntime(starting);
      return { state: starting.state, label: runtimeStateLabel(starting.state), tabId: starting.tabId };
    }
    if (stored.state === "ready" && !isColabRuntimeStale(stored)) {
      return { state: stored.state, label: runtimeStateLabel(stored.state), tabId: stored.tabId };
    }
  } catch {
    await clearColabRuntimeForTab(stored.tabId);
    return { state: "stopped", label: runtimeStateLabel("stopped") };
  }
  const stale = { ...stored, state: "stale" as const, error: stored.error || "Colab 后端未在规定时间内就绪。" };
  await writeColabRuntime(stale);
  return { state: stale.state, label: runtimeStateLabel(stale.state), tabId: stale.tabId, error: stale.error };
}

async function isHealthyControlEvent(event: any, sessionId: string): Promise<boolean> {
  if (event?.type !== "control" || event.session_id !== sessionId) return false;
  try {
    const health = decodeColabControlValue(await callColabControl({
      baseUrl: event.base_url,
      token: event.token,
      apiName: "health",
      data: []
    }, {
      connectAttempts: 2,
      connectTimeoutMs: 3_000,
      resultAttempts: 2,
      resultTimeoutMs: 5_000
    })) as any;
    return health?.ok === true && health?.protocol === 1 && health?.sessionId === sessionId;
  } catch {
    return false;
  }
}

async function findColabHelperTabs(): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({ url: "https://colab.research.google.com/*" });
  return tabs.filter((tab) => Boolean(getColabSessionId(tab.url)));
}

function findPreferredHelperTab(tabs: chrome.tabs.Tab[], stored: ColabRuntimeSnapshot | null): chrome.tabs.Tab | undefined {
  return tabs.find((tab) => tab.id === stored?.tabId) || tabs[0];
}

function orderHelperTabs(tabs: chrome.tabs.Tab[], stored: ColabRuntimeSnapshot | null): chrome.tabs.Tab[] {
  const preferred = findPreferredHelperTab(tabs, stored);
  return preferred ? [preferred, ...tabs.filter((tab) => tab.id !== preferred.id)] : tabs;
}

async function relayColabEvent(payload: any, sender: chrome.runtime.MessageSender): Promise<{ relayed: true }> {
  if (!String(sender.url || sender.tab?.url || "").startsWith("https://colab.research.google.com/")) throw new Error("Colab 事件来源无效。");
  const targetTabId = Number(payload?.targetTabId);
  const sessionId = String(payload?.sessionId || "");
  if (!/^[A-Za-z0-9_-]{12,100}$/u.test(sessionId)) {
    throw new Error("Colab 事件目标无效。");
  }
  const message = {
    channel: "nlm-colab-events",
    sessionId,
    event: payload?.event
  };
  rememberColabSessionEvent(sessionId, payload?.event);
  await syncRuntimeFromEvent(sessionId, payload?.event, sender.tab?.id);
  if (payload?.targetTabId !== null && Number.isSafeInteger(targetTabId) && targetTabId >= 0) {
    await chrome.tabs.sendMessage(targetTabId, message);
  } else {
    const tabs = await chrome.tabs.query({ url: ["https://notebook.google.com/*", "https://notebooklm.google.com/*"] });
    await Promise.allSettled(tabs.filter((tab) => tab.id !== undefined).map((tab) => chrome.tabs.sendMessage(tab.id!, message)));
  }
  return { relayed: true };
}

async function relayColabFrameEvent(payload: any, sender: chrome.runtime.MessageSender): Promise<{ relayed: true }> {
  const frameUrl = new URL(String(sender.url || ""));
  const topUrl = new URL(String(sender.tab?.url || ""));
  if (frameUrl.protocol !== "https:" || !frameUrl.hostname.endsWith(".googleusercontent.com") || frameUrl.pathname !== "/outputframe.html") {
    throw new Error("Colab 输出事件来源无效。");
  }
  if (topUrl.origin !== "https://colab.research.google.com") throw new Error("Colab 顶层页面来源无效。");
  const event = payload?.event;
  const urlSessionId = topUrl.searchParams.get("nlm_session") || "";
  const eventSessionId = event?.type === "control" ? String(event.session_id || "") : "";
  const sessionId = eventSessionId || urlSessionId;
  if (!/^[A-Za-z0-9_-]{12,100}$/u.test(sessionId) || (eventSessionId && urlSessionId && eventSessionId !== urlSessionId)) {
    throw new Error("Colab 输出会话无效。");
  }
  rememberColabSessionEvent(sessionId, event);
  await syncRuntimeFromEvent(sessionId, event, sender.tab?.id);
  await broadcastNotebookEvent(sessionId, event);
  if (sender.tab?.id) {
    await chrome.tabs.sendMessage(sender.tab.id, { channel: "nlm-colab-frame-status", event }).catch(() => undefined);
  }
  return { relayed: true };
}

function rememberColabSessionEvent(sessionId: string, event: unknown): void {
  if (!event || typeof event !== "object" || !["control", "fatal"].includes(String((event as any).type || ""))) return;
  const now = Date.now();
  colabSessionEvents.set(sessionId, { event, receivedAt: now });
  for (const [key, value] of colabSessionEvents) {
    if (now - value.receivedAt > COLAB_SESSION_EVENT_TTL_MS) colabSessionEvents.delete(key);
  }
}

async function syncRuntimeFromEvent(sessionId: string, event: any, senderTabId?: number): Promise<void> {
  if (!isValidColabSessionId(sessionId) || !event || typeof event !== "object") return;
  await updateColabRuntime((current) => {
    if (current && current.sessionId !== sessionId) return current;
    const tabId = senderTabId ?? current?.tabId;
    if (!Number.isSafeInteger(tabId)) return current;
    const now = Date.now();
    if (event.type === "control") {
      return {
        tabId: tabId!,
        sessionId,
        state: "ready",
        startedAt: current?.startedAt || now,
        lastSeenAt: now
      };
    }
    if (event.type === "fatal") {
      return {
        tabId: tabId!,
        sessionId,
        state: "failed",
        startedAt: current?.startedAt || now,
        lastSeenAt: now,
        error: String(event.message || "Colab 启动失败。")
      };
    }
    return current;
  });
}

function getColabSessionEvent(payload: any): unknown {
  const sessionId = String(payload?.sessionId || "");
  if (!/^[A-Za-z0-9_-]{12,100}$/u.test(sessionId)) throw new Error("Colab 会话编号无效。");
  const cached = colabSessionEvents.get(sessionId);
  if (!cached) return null;
  if (Date.now() - cached.receivedAt > COLAB_SESSION_EVENT_TTL_MS) {
    colabSessionEvents.delete(sessionId);
    return null;
  }
  return cached.event;
}

async function broadcastNotebookEvent(sessionId: string, event: unknown): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["https://notebook.google.com/*", "https://notebooklm.google.com/*"] });
  const message = { channel: "nlm-colab-events", sessionId, event };
  await Promise.allSettled(tabs.filter((tab) => tab.id !== undefined).map((tab) => chrome.tabs.sendMessage(tab.id!, message)));
}

function isNotebookSender(sender: chrome.runtime.MessageSender): boolean {
  try {
    const url = new URL(String(sender.url || sender.tab?.url || ""));
    return url.protocol === "https:" && ["notebook.google.com", "notebooklm.google.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  try {
    return new URL(String(sender.url || "")).origin === new URL(chrome.runtime.getURL("/")).origin;
  } catch {
    return false;
  }
}

async function handleSheetUpsert(request: SheetUpsertRequest): Promise<unknown> {
  const settings = await storage.getBucket(sheetSettingsStorageKey, { autoFillDefault: true });
  if (!settings.deploymentUrl) {
    throw new Error("请先在插件图标中保存 Apps Script 部署链接。");
  }
  return upsertSheetRecords({
    ...request,
    deploymentUrl: settings.deploymentUrl
  });
}
