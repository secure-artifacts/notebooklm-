import { parseColabBridgeOutput } from "@/lib/colabProvider";

const runtimeChannel = "nlm-transcript-background";
const seenEvents = new Set<string>();
let scanTimer: number | null = null;

if (window.location.pathname === "/outputframe.html") {
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  scheduleScan();
  window.setInterval(scanOutput, 1000);
}

function scheduleScan(): void {
  if (scanTimer !== null) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    scanOutput();
  }, 120);
}

function scanOutput(): void {
  // Colab auto-links URLs in output. `innerText` may insert visual line breaks
  // inside the JSON string, while textContent preserves the emitted payload.
  const text = String(document.body?.textContent || "");
  const tail = text.length > 200_000 ? text.slice(-200_000) : text;
  for (const event of parseColabBridgeOutput(tail)) {
    if (seenEvents.has(event.event_id)) continue;
    seenEvents.add(event.event_id);
    void sendBackground("relayColabFrameEvent", { event });
  }
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
