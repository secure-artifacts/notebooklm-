(function () {
  "use strict";

  const APP_ID = "nlm-video-translation-helper";
  const PANEL_SETTINGS_KEY = "nlmTranscriptPanelSettings";
  const SHEET_SETTINGS_KEY = "nlmSheetApiSettings";
  const API_TIMEOUT_MS = 10 * 60 * 1000;
  const MAX_LOGS = 40;

  const state = {
    records: [],
    isBusy: false,
    translateEnabled: false,
    databaseUrl: "",
    minimized: false,
    panelLayout: null,
    suppressClick: false,
    stage: "准备就绪",
    logs: [],
    root: null
  };
  const pendingRequests = new Map();

  boot();

  function boot() {
    injectPageHook();
    window.addEventListener("message", handlePageMessage);
    document.addEventListener("DOMContentLoaded", initialize);
    if (document.readyState !== "loading") initialize();
  }

  async function initialize() {
    const saved = await chrome.storage.local.get([PANEL_SETTINGS_KEY, SHEET_SETTINGS_KEY]);
    const panelSettings = saved[PANEL_SETTINGS_KEY] || {};
    const sheetSettings = saved[SHEET_SETTINGS_KEY] || {};
    state.translateEnabled = Boolean(panelSettings.translateEnabled);
    state.databaseUrl = String(sheetSettings.databaseUrl || "");
    state.minimized = Boolean(panelSettings.minimized);
    state.panelLayout = panelSettings.layout || null;
    createPanel();
    addLog("已就绪，等待提取来源。", "系统");
  }

  function injectPageHook() {
    if (document.documentElement.dataset.nlmHelperInjected === "true") return;
    document.documentElement.dataset.nlmHelperInjected = "true";
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/page-hook.js");
    script.onload = () => script.remove();
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  function createPanel() {
    if (document.getElementById(APP_ID)) return;
    const root = document.createElement("section");
    root.id = APP_ID;
    root.className = "nlm-register-panel";
    root.innerHTML = `
      <header class="nlm-register-header">
        <div class="nlm-brand">
          ${brandIconMarkup("nlm-brand-mark")}
          <div><strong>转录登记</strong><span>NotebookLM 助手</span></div>
        </div>
        <div class="nlm-header-actions">
          <label class="nlm-translate-toggle"><input type="checkbox" data-role="translate-toggle"><span>谷歌翻译</span></label>
          <button type="button" class="nlm-minimize" data-action="minimize" aria-label="最小化" title="最小化">−</button>
        </div>
      </header>
      <main>
        <section class="nlm-fixed-section">
          <label class="nlm-sheet-config">
            <span><b>写入表格</b><small data-role="sheet-save-state">自动缓存</small></span>
            <input type="url" data-role="database-url" placeholder="粘贴含 gid 的 Google 表格链接">
          </label>
          <div class="nlm-count-card"><div><b data-role="record-count">0</b><span>个来源</span></div><small>已提取并准备登记</small></div>
          <div class="nlm-register-actions">
            <button type="button" data-action="extract"><span>提取转录</span><small>读取全部来源</small></button>
            <button type="button" data-action="register"><span>登记表格</span><small>写入 Google Sheets</small></button>
          </div>
          <div class="nlm-copy-row"><button type="button" data-action="copy">复制三列表格</button><span data-role="status">准备就绪</span></div>
        </section>
        <details class="nlm-results">
          <summary><span>结果与登记日志</span><small>来源名 / 转录 / 中文翻译</small></summary>
          <div class="nlm-results-scroll">
            <section class="nlm-log-card"><strong>登记结果</strong><div data-role="logs"></div></section>
            <div class="nlm-table-wrap" data-role="results"></div>
          </div>
        </details>
      </main>
      <button type="button" class="nlm-orb" data-action="minimize" aria-label="展开转录登记" title="展开转录登记">${brandIconMarkup("nlm-orb-mark")}</button>`;
    document.documentElement.appendChild(root);
    state.root = root;
    state.root.querySelector("[data-role='database-url']").value = state.databaseUrl;
    restorePanelLayout();
    bindPanel();
    render();
  }

  function bindPanel() {
    state.root.querySelector("[data-role='translate-toggle']").addEventListener("change", async (event) => {
      state.translateEnabled = event.target.checked;
      await savePanelSettings();
      if (state.translateEnabled && state.records.some((record) => record.transcript && !record.translation && !record.error)) {
        await translateExistingRecords();
      } else {
        setStage(state.translateEnabled ? "翻译已开启" : "翻译已关闭");
      }
    });
    state.root.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      if (state.suppressClick) {
        state.suppressClick = false;
        event.preventDefault();
        return;
      }
      if (button.dataset.action === "minimize") {
        toggleMinimized();
        return;
      }
      if (state.isBusy) return;
      if (button.dataset.action === "extract") extractAllSources();
      if (button.dataset.action === "register") registerToSheet();
      if (button.dataset.action === "copy") copyTable();
    });
    bindPanelDrag();
    bindPanelResizePersistence();
    bindDatabaseUrlInput();
  }

  function handlePageMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== APP_ID) return;
    const { type, target, requestId, payload } = event.data;
    if (type === "page-log") return;
    if (target !== "content") return;
    if (type === "api-progress") {
      if (payload && payload.stage) setStage(payload.stage);
      return;
    }
    if (type !== "api-response") return;
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    pendingRequests.delete(requestId);
    clearTimeout(pending.timeoutId);
    if (payload && payload.ok) pending.resolve(payload.result);
    else pending.reject(new Error((payload && payload.error && payload.error.message) || "提取来源失败。"));
  }

  async function extractAllSources() {
    state.isBusy = true;
    state.records = [];
    setStage("正在提取转录…");
    render();
    try {
      const result = await callPageApi("extract-existing-sources", {}, API_TIMEOUT_MS);
      state.records = Array.isArray(result.records)
        ? result.records.map((record) => ({ ...record, sourceName: stripSourceSuffix(record.sourceName) }))
        : [];
      addLog(`已提取 ${state.records.length} 个来源。`, "提取");
      if (state.translateEnabled) await translateRecords();
      setStage(state.translateEnabled ? "提取与翻译完成" : "提取完成");
    } catch (error) {
      setStage("提取失败");
      addLog(error.message || String(error), "失败");
    } finally {
      state.isBusy = false;
      render();
    }
  }

  async function translateExistingRecords() {
    state.isBusy = true;
    render();
    try {
      await translateRecords();
      setStage("已有转录已翻译");
    } finally {
      state.isBusy = false;
      render();
    }
  }

  async function translateRecords() {
    const records = state.records.filter((record) => record.transcript && !record.error && !record.translation);
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      setStage(`正在翻译 ${index + 1}/${records.length}`);
      try {
        record.translation = await callGoogleTranslate(record.transcript);
      } catch (error) {
        record.translationError = error.message || String(error);
        addLog(`${record.sourceName || "未命名来源"}：${record.translationError}`, "翻译失败");
      }
      render();
    }
  }

  async function registerToSheet() {
    const available = state.records.filter((record) => record.transcript && !record.error);
    if (!available.length) {
      setStage("请先提取转录");
      return;
    }
    const saved = await chrome.storage.local.get(SHEET_SETTINGS_KEY);
    const settings = saved[SHEET_SETTINGS_KEY] || {};
    const databaseUrl = state.root.querySelector("[data-role='database-url']").value.trim();
    if (databaseUrl !== settings.databaseUrl) {
      settings.databaseUrl = databaseUrl;
      await chrome.storage.local.set({ [SHEET_SETTINGS_KEY]: settings });
    }
    if (!validDeploymentUrl(settings.deploymentUrl)) {
      setStage("请先在插件图标中保存部署链接");
      return;
    }
    if (!validDatabaseUrl(databaseUrl)) {
      setStage("请填写含 gid 的 Google 表格编辑链接");
      return;
    }

    state.isBusy = true;
    setStage("正在登记表格…");
    state.logs = [];
    addLog("请求已发送，等待表格服务响应。", "登记");
    render();
    try {
      const records = available.map((record) => ({
        post_id: sourceNameToPostId(record.sourceName),
        audio_content: record.transcript,
        audio_content_zh: record.translation || ""
      }));
      const result = await callSheetUpsert(settings.deploymentUrl, databaseUrl, records);
      if (!result || result.ok !== true) {
        showApiFailure(result);
        return;
      }
      const summary = result.data && result.data.summary;
      const outcomes = (result.data && result.data.results) || [];
      state.logs = [];
      addLog(formatStatusCounts(summary && summary.status_counts), "status_counts");
      outcomes.filter((outcome) => outcome && outcome.success === false).forEach((outcome) => {
        const original = records[Number.isInteger(outcome.index) ? outcome.index : -1];
        const postId = outcome.post_id || (original && original.post_id) || `第 ${(outcome.index || 0) + 1} 条`;
        const error = outcome.error || {};
        const code = error.code ? ` [${error.code}]` : "";
        addLog(`${postId}${code}：${error.message || "处理失败（服务未返回具体原因）"}`, "失败");
      });
      setStage(`登记完成：成功 ${(summary && summary.success) || 0}，失败 ${(summary && summary.failed) || 0}`);
    } catch (error) {
      setStage("登记失败");
      const details = error.details || {};
      state.logs = [];
      addLog([
        `error.code: ${details.code || "REQUEST_FAILED"}`,
        `http_status: ${details.http_status || "未知"}`,
        `message: ${error.message || String(error)}`,
        details.response_preview ? `response_preview: ${details.response_preview}` : ""
      ].filter(Boolean).join("\n"), "请求失败");
    } finally {
      state.isBusy = false;
      render();
    }
  }

  function callPageApi(action, payload, timeoutMs) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error("提取请求超时。"));
      }, timeoutMs);
      pendingRequests.set(requestId, { resolve, reject, timeoutId });
      window.postMessage({ source: APP_ID, target: "page", type: "api-request", requestId, action, payload }, window.location.origin);
    });
  }

  function callGoogleTranslate(text) {
    return sendBackgroundMessage({ type: "translate-burmese-to-chinese", text }).then((response) => {
      if (response && response.ok) return response.translation || "";
      throw new Error((response && response.error) || "谷歌翻译失败。");
    });
  }

  function callSheetUpsert(deploymentUrl, databaseUrl, records) {
    return sendBackgroundMessage({ type: "sheet-upsert", deploymentUrl, databaseUrl, records }).then((response) => {
      if (response && response.result) return response.result;
      const details = response && response.error;
      const error = new Error((details && details.message) || (typeof details === "string" ? details : "表格登记失败。"));
      error.details = details || null;
      throw error;
    });
  }

  function showApiFailure(result) {
    const apiError = (result && result.error) || {};
    const status = (result && result.http_status) || "未知";
    const requestId = (result && result.request_id) || "无";
    setStage(`登记失败：HTTP ${status}`);
    state.logs = [];
    addLog(`http_status: ${status}\nrequest_id: ${requestId}\nerror.code: ${apiError.code || "UNKNOWN"}\nmessage: ${apiError.message || "服务未返回具体原因"}`, "接口失败");
  }

  function formatStatusCounts(statusCounts) {
    return `status_counts\n${JSON.stringify(statusCounts || {}, null, 2)}`;
  }

  function sendBackgroundMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(response);
      });
    });
  }

  async function copyTable() {
    if (!state.records.length) return setStage("没有可复制的内容");
    try {
      const rows = exportRows();
      const plain = rows.map((row) => row.map((item) => String(item).replace(/\t/g, " ").replace(/\r?\n/g, " ↵ ")).join("\t")).join("\n");
      const html = `<table border="1"><thead><tr>${rows[0].map((heading) => `<th>${escapeHtml(heading)}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).map((row) => `<tr>${row.map((item) => `<td style="white-space:pre-wrap">${escapeHtml(item).replace(/\r?\n/g, "<br>")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      if (typeof ClipboardItem === "function") {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([plain], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
      setStage("已复制表格");
    } catch (error) {
      setStage("复制失败");
      addLog(error.message || String(error), "失败");
    }
  }

  function exportRows() {
    const headers = state.translateEnabled
      ? ["来源名", "完整转录文字", "中文翻译"]
      : ["来源名", "完整转录文字"];
    const rows = state.records.map((record) => state.translateEnabled
      ? [record.sourceName || "未命名来源", record.transcript || "", record.translation || ""]
      : [record.sourceName || "未命名来源", record.transcript || ""]);
    return [headers, ...rows];
  }

  function sourceNameToPostId(sourceName) {
    return stripSourceSuffix(sourceName);
  }

  function stripSourceSuffix(sourceName) {
    let value = String(sourceName || "").trim();
    const queryIndex = value.indexOf("?");
    if (queryIndex >= 0) value = value.slice(0, queryIndex);
    const fragmentIndex = value.indexOf("#", 1);
    if (fragmentIndex >= 0) value = value.slice(0, fragmentIndex);
    return value.replace(/\.[a-z0-9]{1,10}$/i, "").trim();
  }

  function validDeploymentUrl(value) {
    return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:[?#].*)?$/i.test(String(value || ""));
  }

  function validDatabaseUrl(value) {
    return /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+\/edit.*(?:[#?&]gid=\d+)/i.test(String(value || ""));
  }

  function setStage(message) {
    state.stage = message;
    renderStatus();
  }

  function addLog(message, kind) {
    state.logs.unshift({ message, kind, time: new Date().toLocaleTimeString() });
    state.logs = state.logs.slice(0, MAX_LOGS);
    renderLogs();
  }

  function render() {
    if (!state.root) return;
    state.root.classList.toggle("is-busy", state.isBusy);
    state.root.classList.toggle("is-minimized", state.minimized);
    state.root.querySelector("[data-role='translate-toggle']").checked = state.translateEnabled;
    state.root.querySelectorAll("button:not([data-action='minimize'])").forEach((button) => { button.disabled = state.isBusy; });
    const minimizeButton = state.root.querySelector("[data-action='minimize']");
    minimizeButton.title = "最小化";
    minimizeButton.setAttribute("aria-label", "最小化");
    state.root.querySelector("[data-role='record-count']").textContent = String(state.records.length);
    state.root.querySelector("[data-action='copy']").textContent = state.translateEnabled ? "复制三列表格" : "复制两列表格";
    renderStatus();
    renderLogs();
    renderResults();
  }

  function renderStatus() {
    if (!state.root) return;
    const status = state.root.querySelector("[data-role='status']");
    if (status) status.textContent = state.stage;
  }

  function renderLogs() {
    if (!state.root) return;
    const container = state.root.querySelector("[data-role='logs']");
    if (!container) return;
    container.innerHTML = state.logs.map((entry) => `<p><span>${escapeHtml(entry.kind)}</span>${escapeHtml(entry.message)}<time>${escapeHtml(entry.time)}</time></p>`).join("");
  }

  function renderResults() {
    if (!state.root) return;
    const container = state.root.querySelector("[data-role='results']");
    if (!state.records.length) {
      container.innerHTML = "<p>尚无来源记录。</p>";
      return;
    }
    container.innerHTML = `<table><thead><tr><th>来源名</th><th>完整转录文字</th><th>中文翻译</th></tr></thead><tbody>${state.records.map((record) => `<tr><td>${escapeHtml(record.sourceName || "未命名来源")}</td><td>${record.error ? `<i>${escapeHtml(record.error)}</i>` : `<pre>${escapeHtml(record.transcript || "")}</pre>`}</td><td>${record.translationError ? `<i>${escapeHtml(record.translationError)}</i>` : `<pre>${escapeHtml(record.translation || "")}</pre>`}</td></tr>`).join("")}</tbody></table>`;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function toggleMinimized() {
    if (!state.minimized) rememberPanelLayout();
    state.minimized = !state.minimized;
    render();
    savePanelSettings();
  }

  function bindPanelDrag() {
    const header = state.root.querySelector(".nlm-register-header");
    const orb = state.root.querySelector(".nlm-orb");
    bindDragHandle(header, false);
    bindDragHandle(orb, true);
  }

  function bindDragHandle(handle, allowInteractive) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (!allowInteractive && event.target.closest("button, label, input"))) return;
      const rect = state.root.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      state.root.style.left = `${startLeft}px`;
      state.root.style.top = `${startTop}px`;
      state.root.style.right = "auto";
      handle.setPointerCapture(event.pointerId);
      let moved = false;

      const move = (moveEvent) => {
        if (Math.abs(moveEvent.clientX - startX) > 3 || Math.abs(moveEvent.clientY - startY) > 3) moved = true;
        const maxLeft = Math.max(0, window.innerWidth - state.root.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - state.root.offsetHeight);
        state.root.style.left = `${Math.min(maxLeft, Math.max(0, startLeft + moveEvent.clientX - startX))}px`;
        state.root.style.top = `${Math.min(maxTop, Math.max(0, startTop + moveEvent.clientY - startY))}px`;
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        state.suppressClick = allowInteractive && moved;
        rememberPanelLayout();
        savePanelSettings();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
  }

  function bindPanelResizePersistence() {
    if (typeof ResizeObserver !== "function") return;
    let timerId = 0;
    const observer = new ResizeObserver(() => {
      clearTimeout(timerId);
      timerId = setTimeout(() => {
        if (state.minimized) return;
        rememberPanelLayout();
        savePanelSettings();
      }, 250);
    });
    observer.observe(state.root);
  }

  function bindDatabaseUrlInput() {
    const input = state.root.querySelector("[data-role='database-url']");
    const saveState = state.root.querySelector("[data-role='sheet-save-state']");
    let timerId = 0;
    const save = async () => {
      clearTimeout(timerId);
      state.databaseUrl = input.value.trim();
      const saved = await chrome.storage.local.get(SHEET_SETTINGS_KEY);
      const settings = saved[SHEET_SETTINGS_KEY] || {};
      settings.databaseUrl = state.databaseUrl;
      await chrome.storage.local.set({ [SHEET_SETTINGS_KEY]: settings });
      const valid = validDatabaseUrl(state.databaseUrl);
      input.classList.toggle("is-invalid", Boolean(state.databaseUrl) && !valid);
      saveState.textContent = !state.databaseUrl ? "等待填写" : valid ? "已缓存" : "格式待检查";
      saveState.classList.toggle("is-error", Boolean(state.databaseUrl) && !valid);
    };
    input.addEventListener("input", () => {
      state.databaseUrl = input.value.trim();
      saveState.textContent = "正在缓存…";
      saveState.classList.remove("is-error");
      clearTimeout(timerId);
      timerId = setTimeout(save, 450);
    });
    input.addEventListener("blur", save);
    const initialValid = validDatabaseUrl(state.databaseUrl);
    input.classList.toggle("is-invalid", Boolean(state.databaseUrl) && !initialValid);
    saveState.textContent = !state.databaseUrl ? "等待填写" : initialValid ? "已缓存" : "格式待检查";
    saveState.classList.toggle("is-error", Boolean(state.databaseUrl) && !initialValid);
  }

  function rememberPanelLayout() {
    const rect = state.root.getBoundingClientRect();
    const layout = {
      ...(state.panelLayout || {}),
      left: Math.round(rect.left),
      top: Math.round(rect.top)
    };
    if (!state.minimized) {
      layout.width = Math.round(rect.width);
      layout.height = Math.round(rect.height);
    }
    state.panelLayout = layout;
  }

  function restorePanelLayout() {
    const layout = state.panelLayout;
    if (!layout) return;
    if (Number.isFinite(layout.left)) {
      state.root.style.left = `${Math.max(0, Math.min(layout.left, window.innerWidth - 60))}px`;
      state.root.style.right = "auto";
    }
    if (Number.isFinite(layout.top)) state.root.style.top = `${Math.max(0, Math.min(layout.top, window.innerHeight - 44))}px`;
    if (Number.isFinite(layout.width)) state.root.style.width = `${Math.max(300, Math.min(layout.width, window.innerWidth - 16))}px`;
    if (Number.isFinite(layout.height)) state.root.style.height = `${Math.max(320, Math.min(layout.height, window.innerHeight - 16))}px`;
  }

  async function savePanelSettings() {
    await chrome.storage.local.set({
      [PANEL_SETTINGS_KEY]: {
        translateEnabled: state.translateEnabled,
        minimized: state.minimized,
        layout: state.panelLayout
      }
    });
  }

  function brandIconMarkup(className) {
    return `<img class="${className}" src="${chrome.runtime.getURL("assets/icon-128.png")}" alt="">`;
  }
})();
