import { sheetSettingsStorageKey } from "@/const";
import { schema, type SchemaType } from "@/schema";
import { useStorageLocal } from "@webextkits/storage-local";

const storage = useStorageLocal<SchemaType>(schema);
const deploymentInput = document.getElementById("deploymentUrl") as HTMLInputElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const startColabButton = document.getElementById("startColab") as HTMLButtonElement;

void Promise.all([loadSettings(), loadRuntimeStatus()]);

(document.getElementById("openNotebook") as HTMLButtonElement).addEventListener("click", () => {
  chrome.tabs.create({ url: "https://notebooklm.google.com/" });
});

startColabButton.addEventListener("click", async () => {
  startColabButton.disabled = true;
  showStatus("正在检查浏览器中的 Colab 临时后端…");
  try {
    const result = await sendBackground("startColabRuntime", {}) as { ready?: boolean; restarted?: boolean; state?: string };
    if (result.ready) {
      setRuntimeButton("ready");
      showStatus("Colab 临时后端已就绪，已切换到唯一后端标签。");
    } else {
      setRuntimeButton("starting");
      if (result.restarted) showStatus("原 Colab 标签已失效，正在原标签中重新启动。");
      else showStatus("Colab 临时后端正在启动，请等待右上角显示已就绪。");
    }
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    startColabButton.disabled = false;
  }
});

(document.getElementById("saveSettings") as HTMLButtonElement).addEventListener("click", async () => {
  const deploymentUrl = deploymentInput.value.trim();
  if (!isDeploymentUrl(deploymentUrl)) return showStatus("请输入有效的 Apps Script /exec 部署链接。", true);
  const settings = await storage.getBucket(sheetSettingsStorageKey, { autoFillDefault: true });
  settings.deploymentUrl = deploymentUrl;
  await storage.setBucket(sheetSettingsStorageKey, settings);
  showStatus("部署链接已保存；表格链接可在 NotebookLM 面板中随时更换。");
});

async function loadSettings() {
  const settings = await storage.getBucket(sheetSettingsStorageKey, { autoFillDefault: true });
  deploymentInput.value = settings.deploymentUrl || "";
}

async function loadRuntimeStatus() {
  try {
    const result = await sendBackground("getColabRuntimeStatus", {}) as { state?: string; label?: string; error?: string };
    setRuntimeButton(String(result.state || "stopped"));
    if (result.state && result.state !== "stopped") {
      showStatus(`Colab 后端：${result.label || result.state}${result.error ? `（${result.error}）` : ""}`, result.state === "failed" || result.state === "stale");
    }
  } catch {
    setRuntimeButton("stopped");
  }
}

function setRuntimeButton(state: string) {
  if (state === "ready") startColabButton.textContent = "打开已就绪的 Colab 后端";
  else if (state === "starting") startColabButton.textContent = "打开正在启动的 Colab 后端";
  else if (state === "stale" || state === "failed") startColabButton.textContent = "重新启动 Colab 临时后端";
  else startColabButton.textContent = "启动 Colab 临时后端";
}

function isDeploymentUrl(value) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:[?#].*)?$/i.test(value);
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.style.color = isError ? "#b91c1c" : "#0f766e";
}

function sendBackground(action: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ channel: "nlm-transcript-background", action, payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) return reject(new Error(runtimeError.message));
      if (!response?.ok) return reject(new Error(response?.error || "扩展后台未返回结果。"));
      resolve(response.result);
    });
  });
}
