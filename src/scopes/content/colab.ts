import bridgePython from "../../../colab/facebook_notebooklm_bridge.py?raw";
import { buildColabBootstrapSource } from "@/lib/colabBootstrap";
import { findColabRunTarget, replaceColabEditorText, waitForColabEditorMarker } from "./colabAdapter";

const runtimeChannel = "nlm-transcript-background";
const params = new URLSearchParams(window.location.search);
const sessionId = params.get("nlm_session") || "";
const active = /^[A-Za-z0-9_-]{12,100}$/u.test(sessionId);
const contentStartedAt = Date.now();
let runClicked = false;
let finished = false;
let syntheticFailureSent = false;
let runtimeState: "starting" | "ready" | "failed" = "starting";
let lastControlEvent: Record<string, unknown> | null = null;
const relayedOutputEvents = new Set<string>();
const bootstrapCodePromise = active ? buildBootstrapCode() : Promise.resolve({ code: "", marker: "" });

if (active) {
  installStatusBadge();
  window.addEventListener("message", relayOutputFrameMessage);
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.channel === "nlm-colab-runtime-query") {
      sendResponse({ sessionId, event: lastControlEvent, state: runtimeState, startedAt: contentStartedAt });
      return;
    }
    if (message?.channel !== "nlm-colab-frame-status") return;
    const event = message.event;
    if (event?.type === "control" && event.session_id === sessionId) {
      lastControlEvent = event;
      runtimeState = "ready";
      updateBadge("控制通道已就绪，可返回 NotebookLM");
    }
    if (event?.type === "fatal") {
      runtimeState = "failed";
      updateBadge(`启动失败：${String(event.message || "未知错误")}`);
    }
    if (event?.type === "complete" || event?.type === "fatal") finished = true;
  });
  // Colab mutates a large Shadow DOM continuously while loading. Scanning on
  // every mutation can starve its renderer, so use one bounded low-rate poll.
  const timer = window.setInterval(() => {
    if (finished || runClicked) {
      return clearInterval(timer);
    }
    tryRunNotebook();
  }, 800);
  window.setTimeout(() => {
    if (!finished) relaySyntheticFailure("COLAB_START_TIMEOUT", "Colab 启动超时，请确认运行时可用并允许执行该笔记本。");
  }, 3 * 60 * 1000);
}

function relayOutputFrameMessage(message: MessageEvent): void {
  if (!isTrustedOutputOrigin(message.origin)) return;
  const payload = message.data;
  if (payload?.channel !== "nlm-colab-output" || !payload.event || typeof payload.event !== "object") return;
  const event = payload.event;
  if (event.type === "control" && event.session_id !== sessionId) return;
  const eventId = String(event.event_id || "");
  if (!/^[A-Za-z0-9_-]{8,100}$/u.test(eventId) || relayedOutputEvents.has(eventId)) return;
  relayedOutputEvents.add(eventId);
  if (event.type === "control") lastControlEvent = event;
  if (event.type === "control") runtimeState = "ready";
  void sendBackground("relayColabEvent", { targetTabId: null, sessionId, event }).catch(() => undefined);
}

function isTrustedOutputOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.hostname.endsWith(".googleusercontent.com");
  } catch {
    return false;
  }
}

function tryRunNotebook(): void {
  if (runClicked) return;
  const target = findColabRunTarget();
  if (!target) return;
  runClicked = true;
  void writeBootstrapAndRun(target.editor, target.runButton).catch((error) => {
    relaySyntheticFailure("COLAB_SCRIPT_WRITE_FAILED", `写入 Colab 启动脚本失败：${error instanceof Error ? error.message : String(error)}`);
  });
}

async function writeBootstrapAndRun(editor: HTMLTextAreaElement, runButton: HTMLButtonElement): Promise<void> {
  updateBadge("正在准备临时启动脚本…");
  const bootstrap = await bootstrapCodePromise;
  updateBadge("正在写入临时启动脚本…");
  await replaceColabEditorText(editor, bootstrap.code);
  updateBadge("正在校验临时启动脚本…");
  const complete = await waitForColabEditorMarker(editor, bootstrap.marker);
  if (!complete) throw new Error("启动脚本写入不完整，已阻止执行；请刷新 Colab 页面后重试");
  await delay(700);
  updateBadge("正在启动临时运行时…");
  runButton.click();
}

async function buildBootstrapCode(): Promise<{ code: string; marker: string }> {
  const bytes = new TextEncoder().encode(bridgePython);
  let payloadBytes = bytes;
  let compressed = false;
  if (typeof CompressionStream === "function") {
    const compressedBuffer = await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))
    ).arrayBuffer();
    payloadBytes = new Uint8Array(compressedBuffer);
    compressed = true;
  }
  const encoded = encodeBase64Bytes(payloadBytes);
  const checksum = await sha256Hex(payloadBytes);
  return buildColabBootstrapSource({
    sessionId,
    encodedPayload: encoded,
    payloadSha256: checksum,
    compressed
  });
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function relaySyntheticFailure(code: string, message: string): void {
  if (syntheticFailureSent) return;
  syntheticFailureSent = true;
  finished = true;
  runtimeState = "failed";
  const event = {
    event_id: `browser-${Date.now()}`,
    type: "fatal",
    code,
    message
  };
  updateBadge(message);
  void sendBackground("relayColabEvent", { targetTabId: null, sessionId, event });
}

function sendBackground(action: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ channel: runtimeChannel, action, payload }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      if (!response?.ok) return reject(new Error(response?.error || "扩展后台未返回结果。"));
      resolve(response.result);
    });
  });
}

function installStatusBadge(): void {
  const badge = document.createElement("aside");
  badge.id = "nlm-colab-status";
  Object.assign(badge.style, {
    position: "fixed",
    right: "18px",
    top: "18px",
    zIndex: "2147483647",
    padding: "10px 14px",
    borderRadius: "999px",
    color: "#fff",
    background: "#4338ca",
    boxShadow: "0 8px 28px rgba(15,23,42,.2)",
    font: "600 13px/1.3 system-ui, sans-serif"
  });
  badge.textContent = "NotebookLM：准备启动 Colab…";
  document.documentElement.appendChild(badge);
}

function updateBadge(message: string): void {
  const badge = document.getElementById("nlm-colab-status");
  if (badge) badge.textContent = `NotebookLM：${message}`;
}
