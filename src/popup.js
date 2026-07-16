const SETTINGS_KEY = "nlmSheetApiSettings";
const deploymentInput = document.getElementById("deploymentUrl");
const status = document.getElementById("status");

loadSettings();

document.getElementById("openNotebook").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://notebooklm.google.com/" });
});

document.getElementById("saveSettings").addEventListener("click", async () => {
  const deploymentUrl = deploymentInput.value.trim();
  if (!isDeploymentUrl(deploymentUrl)) return showStatus("请输入有效的 Apps Script /exec 部署链接。", true);
  const saved = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = saved[SETTINGS_KEY] || {};
  settings.deploymentUrl = deploymentUrl;
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  showStatus("部署链接已保存；表格链接可在 NotebookLM 面板中随时更换。");
});

async function loadSettings() {
  const saved = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = saved[SETTINGS_KEY] || {};
  deploymentInput.value = settings.deploymentUrl || "";
}

function isDeploymentUrl(value) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:[?#].*)?$/i.test(value);
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.style.color = isError ? "#b91c1c" : "#0f766e";
}
