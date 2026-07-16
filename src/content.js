(function () {
  "use strict";

  const APP_ID = "nlm-video-translation-helper";
  const PANEL_SETTINGS_KEY = "nlmTranscriptPanelSettings";
  const SHEET_SETTINGS_KEY = "nlmSheetApiSettings";
  const API_TIMEOUT_MS = 10 * 60 * 1000;
  const MEDIA_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
  const DRIVE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
  const MAX_LOGS = 120;
  const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
  const PAGE_BRIDGE_TOKEN = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const DRIVE_BRIDGE_TOKEN = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const state = {
    records: [],
    isBusy: false,
    translateEnabled: false,
    autoDeleteImported: true,
    databaseUrl: "",
    minimized: false,
    bottomOpen: true,
    bottomView: "results",
    driveActivity: { download: "", upload: "" },
    panelLayout: null,
    suppressClick: false,
    stage: "准备就绪",
    logs: [],
    root: null
  };
  const pendingRequests = new Map();
  const pendingDriveDownloads = new Map();
  let driveLoaderFrame = null;
  let driveLoaderReady = null;
  let initialized = false;
  let activeNotebookId = "";
  let routeTimerId = 0;

  boot();

  function boot() {
    window.addEventListener("message", handlePageMessage);
    window.addEventListener("message", handleDriveLoaderMessage);
    document.addEventListener("DOMContentLoaded", start);
    if (document.readyState !== "loading") start();
  }

  async function start() {
    if (initialized) return;
    initialized = true;
    await initialize();
    routeTimerId = window.setInterval(syncNotebookRoute, 700);
  }

  async function initialize() {
    const saved = await chrome.storage.local.get([PANEL_SETTINGS_KEY, SHEET_SETTINGS_KEY]);
    const panelSettings = saved[PANEL_SETTINGS_KEY] || {};
    const sheetSettings = saved[SHEET_SETTINGS_KEY] || {};
    state.translateEnabled = Boolean(panelSettings.translateEnabled);
    state.autoDeleteImported = panelSettings.autoDeleteImported !== false;
    state.databaseUrl = String(sheetSettings.databaseUrl || "");
    state.minimized = Boolean(panelSettings.minimized);
    state.panelLayout = panelSettings.layout || null;
    syncNotebookRoute();
    addLog("已就绪，等待提取来源。", "系统");
  }

  function getNotebookId() {
    const match = window.location.pathname.match(/^\/notebook\/([0-9a-f-]+)\/?$/i);
    return match ? match[1] : "";
  }

  function syncNotebookRoute() {
    const notebookId = getNotebookId();
    if (!notebookId) {
      if (activeNotebookId) resetNotebookSession();
      activeNotebookId = "";
      if (state.root) {
        state.root.remove();
        state.root = null;
      }
      return;
    }

    if (activeNotebookId && activeNotebookId !== notebookId) {
      resetNotebookSession();
    }
    activeNotebookId = notebookId;
    injectPageHook();
    if (!state.root || !state.root.isConnected) createPanel();
  }

  function resetNotebookSession() {
    pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("已切换笔记本，当前操作已取消。"));
    });
    pendingRequests.clear();
    pendingDriveDownloads.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("已切换笔记本，当前下载已取消。"));
    });
    pendingDriveDownloads.clear();
    if (driveLoaderFrame) driveLoaderFrame.remove();
    driveLoaderFrame = null;
    driveLoaderReady = null;
    state.records = [];
    state.logs = [];
    state.isBusy = false;
    state.driveActivity = { download: "", upload: "" };
    state.stage = "已切换笔记本";
  }

  function injectPageHook() {
    if (document.documentElement.dataset.nlmHelperInjected === "true") return;
    document.documentElement.dataset.nlmHelperInjected = "true";
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/page-hook.js");
    script.dataset.bridgeToken = PAGE_BRIDGE_TOKEN;
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
            <span><b>登记表格</b><small data-role="sheet-save-state">自动缓存</small></span>
            <input type="url" data-role="database-url" placeholder="粘贴含 gid 的 Google 表格链接">
          </label>
          <details class="nlm-drive-import" open>
            <summary><span><b>Google Drive 音视频导入</b><small>公开链接 · 无需授权</small></span></summary>
            <div class="nlm-drive-import-body">
              <textarea data-role="drive-urls" rows="3" spellcheck="false" placeholder="每行粘贴一个公开的 Google Drive 文件链接"></textarea>
              <div><small>仅接受公开音视频；上传当前文件时预下载下一项。</small><button type="button" data-action="import-drive">开始导入</button></div>
            </div>
          </details>
          <div class="nlm-cleanup-row">
            <label class="nlm-auto-delete-toggle">
              <input type="checkbox" data-role="auto-delete-toggle">
              <span><b>自动移除导入来源</b><small>成功取得转录后释放来源名额</small></span>
            </label>
            <button type="button" data-action="delete-all-sources">清空左侧来源</button>
          </div>
          <div class="nlm-count-card">
            <div class="nlm-count-stat is-total"><b data-role="record-count">0</b><span>总计</span></div>
            <div class="nlm-count-stat is-success"><b data-role="success-count">0</b><span>成功</span></div>
            <div class="nlm-count-stat is-failed"><b data-role="failed-count">0</b><span>失败</span></div>
            <small>仅成功记录可复制和登记</small>
          </div>
          <div class="nlm-register-actions">
            <button type="button" data-action="extract"><span>提取转录</span><small>只读取新来源</small></button>
            <button type="button" data-action="register"><span>登记表格</span><small>写入 Google Sheets</small></button>
          </div>
          <div class="nlm-copy-row">
            <button type="button" data-action="copy">复制三列表格</button>
            <span data-role="status">准备就绪</span>
            <button type="button" class="nlm-clear-records" data-action="clear-records">清除提取记录</button>
          </div>
        </section>
        <section class="nlm-bottom-panel is-open">
          <div class="nlm-bottom-bar">
            <div class="nlm-bottom-tabs" role="tablist" aria-label="结果与日志">
              <button type="button" data-action="show-results" role="tab"><span>转录结果</span><b data-role="result-tab-count">0</b></button>
              <button type="button" data-action="show-logs" role="tab"><span>操作日志</span><b data-role="log-tab-count">0</b></button>
            </div>
            <button type="button" class="nlm-bottom-toggle" data-action="toggle-bottom" aria-label="折叠底部面板" title="折叠底部面板">⌄</button>
          </div>
          <div class="nlm-bottom-content">
            <section class="nlm-bottom-view" data-role="results-view" role="tabpanel">
              <div class="nlm-view-toolbar"><span>本次页面会话内跳过已提取来源</span></div>
              <div class="nlm-results-scroll" data-role="results"></div>
            </section>
            <section class="nlm-bottom-view" data-role="logs-view" role="tabpanel">
              <div class="nlm-log-list" data-role="logs"></div>
            </section>
          </div>
        </section>
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
      render();
      await savePanelSettings();
      if (state.translateEnabled && state.records.some((record) => record.transcript && !record.translation && !record.error)) {
        await translateExistingRecords();
      } else {
        setStage(state.translateEnabled ? "翻译已开启" : "翻译已关闭");
      }
    });
    state.root.querySelector("[data-role='auto-delete-toggle']").addEventListener("change", async (event) => {
      state.autoDeleteImported = event.target.checked;
      setStage(state.autoDeleteImported ? "自动移除已开启" : "自动移除已关闭");
      render();
      await savePanelSettings();
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
      if (button.dataset.action === "show-results") return switchBottomView("results");
      if (button.dataset.action === "show-logs") return switchBottomView("logs");
      if (button.dataset.action === "toggle-bottom") return toggleBottomPanel();
      if (button.dataset.action === "clear-records") {
        if (!state.isBusy) clearRecords();
        return;
      }
      if (state.isBusy) return;
      if (button.dataset.action === "extract") extractAllSources();
      if (button.dataset.action === "import-drive") importDriveMedia();
      if (button.dataset.action === "delete-all-sources") deleteAllSources();
      if (button.dataset.action === "register") registerToSheet();
      if (button.dataset.action === "copy") copyTable();
    });
    bindPanelDrag();
    bindPanelResizePersistence();
    bindDatabaseUrlInput();
  }

  function handlePageMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== APP_ID) return;
    const { type, target, requestId, payload, token } = event.data;
    if (token !== PAGE_BRIDGE_TOKEN) return;
    if (type === "page-log") return;
    if (target !== "content") return;
    if (type === "api-progress") {
      if (payload && payload.stage && !state.driveActivity.upload) setStage(payload.stage);
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

  function handleDriveLoaderMessage(event) {
    if (!driveLoaderFrame || event.source !== driveLoaderFrame.contentWindow || event.origin !== EXTENSION_ORIGIN) return;
    const { source, target, type, token, requestId, payload } = event.data || {};
    if (source !== APP_ID || target !== "content" || token !== DRIVE_BRIDGE_TOKEN) return;
    const pending = pendingDriveDownloads.get(requestId);
    if (!pending) return;

    if (type === "drive-download-progress") {
      const received = Number(payload && payload.receivedBytes) || 0;
      const total = Number(payload && payload.totalBytes) || 0;
      updateDriveActivity("download", `下载 ${pending.position} ${formatBytes(received)}${total ? `/${formatBytes(total)}` : ""}`);
      return;
    }
    if (type !== "drive-download-response") return;

    pendingDriveDownloads.delete(requestId);
    clearTimeout(pending.timeoutId);
    updateDriveActivity("download", "");
    if (payload && payload.ok && payload.file instanceof File) {
      pending.resolve(payload.file);
    } else {
      pending.reject(new Error((payload && payload.error) || "Drive 文件下载失败。"));
    }
  }

  async function importDriveMedia() {
    const input = state.root.querySelector("[data-role='drive-urls']");
    const urls = parseDriveUrls(input.value);
    if (!urls.length) {
      setStage("请粘贴有效的 Drive 文件链接");
      return;
    }

    state.isBusy = true;
    state.logs = [];
    state.bottomOpen = true;
    state.bottomView = "logs";
    addLog(`准备流水线导入 ${urls.length} 个公开 Drive 文件：单路上传，同时预下载下一项。`, "导入");
    render();

    let succeeded = 0;
    let failed = 0;
    let processingFailed = 0;
    let transcriptsAdded = 0;
    let autoDeleted = 0;
    const uploadedSources = [];
    const extractedSourceIds = [];

    try {
      await ensureDriveLoader();
      let downloadTask = startDriveDownload(urls[0], 0, urls.length);
      for (let index = 0; index < urls.length; index += 1) {
        const position = `${index + 1}/${urls.length}`;
        const downloaded = await downloadTask;
        downloadTask = index + 1 < urls.length
          ? startDriveDownload(urls[index + 1], index + 1, urls.length)
          : null;

        if (!downloaded.ok) {
          failed += 1;
          addLog(`${position} ${downloaded.error.message || String(downloaded.error)}`, "下载失败");
          render();
          continue;
        }

        const file = downloaded.file;
        try {
          const mediaKind = file.type.startsWith("video/") ? "视频" : "音频";
          addLog(`${position} 已识别${mediaKind}：${file.name}（${file.type}，${formatBytes(file.size)}）`, "下载");

          updateDriveActivity("upload", `上传 ${position} ${file.name}`);
          const result = await callPageApi("upload-media-source", {
            file,
            options: { timeoutMs: MEDIA_UPLOAD_TIMEOUT_MS, pollIntervalMs: 3000 }
          }, MEDIA_UPLOAD_TIMEOUT_MS);

          succeeded += 1;
          addLog(`${position} 已加入 NotebookLM：${file.name}`, "成功");
          if (result && result.sourceId) {
            uploadedSources.push({ sourceId: result.sourceId, fileName: result.fileName || file.name });
          }
        } catch (error) {
          failed += 1;
          addLog(`${position} ${error.message || String(error)}`, "上传失败");
        } finally {
          updateDriveActivity("upload", "");
        }
        render();
      }

      if (uploadedSources.length) {
        setStage(`已上传 ${uploadedSources.length} 个文件，等待 NotebookLM 生成转录…`);
        addLog(`上传阶段结束，开始统一等待并提取 ${uploadedSources.length} 个新增来源。`, "提取");
        try {
          const sourceNames = Object.fromEntries(uploadedSources.map((item) => [item.sourceId, item.fileName]));
          const result = await callPageApi("extract-existing-sources", {
            sourceIds: uploadedSources.map((item) => item.sourceId),
            sourceNames,
            waitForReady: true,
            timeoutMs: MEDIA_UPLOAD_TIMEOUT_MS,
            pollIntervalMs: 3000
          }, MEDIA_UPLOAD_TIMEOUT_MS);
          const returnedRecords = Array.isArray(result.records) ? result.records : [];
          const returnedIds = new Set(returnedRecords.map((record) => record.sourceId).filter(Boolean));
          const missingRecords = uploadedSources
            .filter((item) => item.sourceId && !returnedIds.has(item.sourceId))
            .map((item) => ({
              sourceId: item.sourceId,
              sourceName: item.fileName,
              transcript: "",
              error: "NotebookLM 未返回该来源的处理结果。"
            }));
          const importedRecords = [...returnedRecords, ...missingRecords];
          transcriptsAdded = mergeRecords(importedRecords);
          processingFailed += importedRecords.filter((record) => record.error || !record.transcript).length;
          extractedSourceIds.push(...importedRecords
            .filter((record) => record.sourceId && record.transcript && !record.error)
            .map((record) => record.sourceId));
          importedRecords.filter((record) => record.error).forEach((record) => {
            addLog(`${record.sourceName || record.sourceId}：${record.error}`, "转录失败");
          });
        } catch (error) {
          const message = error.message || String(error);
          const failedRecords = uploadedSources.map((item) => ({
            sourceId: item.sourceId,
            sourceName: item.fileName,
            transcript: "",
            error: message
          }));
          processingFailed += failedRecords.length;
          mergeRecords(failedRecords);
          addLog(`文件已上传，但统一提取转录失败：${message}`, "转录失败");
        }
      }

      if (state.translateEnabled && transcriptsAdded) await translateRecords();
      if (state.autoDeleteImported && extractedSourceIds.length) {
        setStage(`正在移除 ${extractedSourceIds.length} 个已完成来源…`);
        try {
          const deletion = await deleteNotebookSources(extractedSourceIds);
          autoDeleted = deletion.deleted.length;
          markSourcesDeleted(deletion.deleted);
          addLog(`自动移除成功 ${autoDeleted} 个；失败 ${deletion.failed.length} 个。`, "来源清理");
          deletion.failed.forEach((item) => addLog(`${item.sourceName || item.sourceId}：${item.error}`, "移除失败"));
        } catch (error) {
          addLog(`转录已保留，但自动移除失败：${error.message || String(error)}`, "移除失败");
        }
      }
      const totalFailed = failed + processingFailed;
      setStage(totalFailed
        ? `导入结束：转录成功 ${transcriptsAdded}，失败 ${totalFailed}`
        : `导入完成：成功 ${transcriptsAdded}`);
      addLog(`总计 ${urls.length}；上传成功 ${succeeded}；上传失败 ${failed}；转录成功 ${transcriptsAdded}；转录失败 ${processingFailed}；自动移除 ${autoDeleted}。`, "汇总");
    } catch (error) {
      setStage("Drive 导入初始化失败");
      addLog(error.message || String(error), "失败");
    } finally {
      state.driveActivity.download = "";
      state.driveActivity.upload = "";
      state.isBusy = false;
      render();
    }
  }

  async function deleteAllSources() {
    const confirmed = window.confirm("确定要永久移除当前笔记本中的全部来源吗？\n\n已提取到插件面板中的文字会保留，但 NotebookLM 来源无法恢复。");
    if (!confirmed) {
      setStage("已取消清空来源");
      return;
    }

    state.isBusy = true;
    state.bottomOpen = true;
    state.bottomView = "logs";
    setStage("正在读取并移除全部来源…");
    addLog("用户已确认清空当前笔记本来源。", "来源清理");
    render();
    try {
      const result = await deleteNotebookSources();
      markSourcesDeleted(result.deleted);
      addLog(`批量移除完成：成功 ${result.deleted.length} 个，失败 ${result.failed.length} 个。`, "来源清理");
      result.failed.forEach((item) => addLog(`${item.sourceName || item.sourceId}：${item.error}`, "移除失败"));
      setStage(result.failed.length
        ? `来源清理完成：成功 ${result.deleted.length}，失败 ${result.failed.length}`
        : `已移除 ${result.deleted.length} 个来源`);
    } catch (error) {
      setStage("批量移除来源失败");
      addLog(error.message || String(error), "移除失败");
    } finally {
      state.isBusy = false;
      render();
    }
  }

  function deleteNotebookSources(sourceIds) {
    return callPageApi("delete-sources", {
      sourceIds: Array.isArray(sourceIds) ? Array.from(new Set(sourceIds.filter(Boolean))) : []
    }, API_TIMEOUT_MS);
  }

  function markSourcesDeleted(sourceIds) {
    const deletedIds = new Set(Array.isArray(sourceIds) ? sourceIds : []);
    state.records.forEach((record) => {
      if (deletedIds.has(record.sourceId)) record.sourceDeleted = true;
    });
  }

  function startDriveDownload(url, index, total) {
    const position = `${index + 1}/${total}`;
    updateDriveActivity("download", `下载 ${position}`);
    return downloadDriveMedia(url, position)
      .then((file) => ({ ok: true, file }))
      .catch((error) => ({ ok: false, error }));
  }

  function ensureDriveLoader() {
    if (driveLoaderReady) return driveLoaderReady;
    driveLoaderFrame = document.createElement("iframe");
    driveLoaderFrame.className = "nlm-drive-loader-frame";
    driveLoaderFrame.setAttribute("aria-hidden", "true");
    driveLoaderFrame.src = `${chrome.runtime.getURL("src/drive-loader.html")}#token=${encodeURIComponent(DRIVE_BRIDGE_TOKEN)}`;
    driveLoaderReady = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error("Drive 下载组件加载超时。")), 15000);
      driveLoaderFrame.addEventListener("load", () => {
        clearTimeout(timeoutId);
        resolve();
      }, { once: true });
      driveLoaderFrame.addEventListener("error", () => {
        clearTimeout(timeoutId);
        reject(new Error("Drive 下载组件加载失败。"));
      }, { once: true });
    });
    document.documentElement.appendChild(driveLoaderFrame);
    return driveLoaderReady;
  }

  async function downloadDriveMedia(url, position) {
    await ensureDriveLoader();
    const requestId = `drive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingDriveDownloads.delete(requestId);
        reject(new Error("Drive 文件下载超时。"));
      }, DRIVE_DOWNLOAD_TIMEOUT_MS);
      pendingDriveDownloads.set(requestId, { resolve, reject, timeoutId, position });
      driveLoaderFrame.contentWindow.postMessage({
        source: APP_ID,
        target: "drive-loader",
        type: "drive-download-request",
        token: DRIVE_BRIDGE_TOKEN,
        requestId,
        url
      }, EXTENSION_ORIGIN);
    });
  }

  function parseDriveUrls(value) {
    const matches = String(value || "").match(/https:\/\/drive\.google\.com\/[^\s<>"']+/gi) || [];
    const seenIds = new Set();
    const urls = [];
    matches.forEach((rawUrl) => {
      const url = rawUrl.replace(/[)\]，。；;]+$/g, "");
      const fileId = extractDriveFileId(url);
      if (!fileId || seenIds.has(fileId)) return;
      seenIds.add(fileId);
      urls.push(url);
    });
    return urls;
  }

  function extractDriveFileId(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:" || !/(^|\.)drive\.google\.com$/i.test(url.hostname)) return "";
      const pathMatch = url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
      const candidate = (pathMatch && pathMatch[1]) || url.searchParams.get("id") || "";
      return /^[a-zA-Z0-9_-]{10,}$/.test(candidate) ? candidate : "";
    } catch (_error) {
      return "";
    }
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function updateDriveActivity(kind, value) {
    state.driveActivity[kind] = value;
    const stages = [state.driveActivity.upload, state.driveActivity.download].filter(Boolean);
    if (stages.length) setStage(stages.join(" · "));
  }

  async function extractAllSources() {
    state.isBusy = true;
    state.bottomOpen = true;
    state.bottomView = "results";
    setStage("正在检查新来源…");
    render();
    try {
      const cachedSourceIds = state.records
        .filter((record) => record.sourceId && record.transcript && !record.error)
        .map((record) => record.sourceId);
      const result = await callPageApi("extract-existing-sources", {
        skipSourceIds: cachedSourceIds
      }, API_TIMEOUT_MS);
      const received = Array.isArray(result.records) ? result.records : [];
      const extracted = mergeRecords(received);
      const failed = received.filter((record) => record.error || !record.transcript).length;
      const skipped = Number(result.skipped) || 0;
      addLog(`提取成功 ${extracted} 个；失败 ${failed} 个；跳过会话内已有记录 ${skipped} 个。`, failed ? "提取完成（有失败）" : "提取");
      if (state.translateEnabled && extracted) await translateRecords();
      setStage(failed
        ? `提取结束：成功 ${extracted}，失败 ${failed}`
        : extracted
        ? (state.translateEnabled ? "新来源提取与翻译完成" : "新来源提取完成")
        : `没有新来源，已跳过 ${skipped} 个`);
    } catch (error) {
      setStage("提取失败");
      addLog(error.message || String(error), "失败");
    } finally {
      state.isBusy = false;
      render();
    }
  }

  function mergeRecords(records) {
    let transcriptCount = 0;
    records.forEach((incoming) => {
      const record = {
        ...incoming,
        sourceName: stripSourceSuffix(incoming.sourceName)
      };
      const existingIndex = record.sourceId
        ? state.records.findIndex((item) => item.sourceId === record.sourceId)
        : -1;
      if (existingIndex >= 0) state.records[existingIndex] = { ...state.records[existingIndex], ...record };
      else state.records.push(record);
      if (record.transcript && !record.error) transcriptCount += 1;
    });
    return transcriptCount;
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
    const available = getSuccessfulRecords();
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
    state.bottomOpen = true;
    state.bottomView = "logs";
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
        reject(new Error("NotebookLM 页面请求超时。"));
      }, timeoutMs);
      pendingRequests.set(requestId, { resolve, reject, timeoutId });
      window.postMessage({ source: APP_ID, target: "page", type: "api-request", token: PAGE_BRIDGE_TOKEN, requestId, action, payload }, window.location.origin);
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
    if (!getSuccessfulRecords().length) return setStage("没有成功的转录可复制");
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
    const rows = getSuccessfulRecords().map((record) => state.translateEnabled
      ? [record.sourceName || "未命名来源", record.transcript || "", record.translation || ""]
      : [record.sourceName || "未命名来源", record.transcript || ""]);
    return [headers, ...rows];
  }

  function getSuccessfulRecords() {
    return state.records.filter((record) => record.transcript && !record.error);
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
    renderBottomPanel();
    renderLogs();
  }

  function render() {
    if (!state.root) return;
    state.root.classList.toggle("is-busy", state.isBusy);
    state.root.classList.toggle("is-minimized", state.minimized);
    const translateToggle = state.root.querySelector("[data-role='translate-toggle']");
    translateToggle.checked = state.translateEnabled;
    translateToggle.disabled = state.isBusy;
    const autoDeleteToggle = state.root.querySelector("[data-role='auto-delete-toggle']");
    autoDeleteToggle.checked = state.autoDeleteImported;
    autoDeleteToggle.disabled = state.isBusy;
    state.root.querySelectorAll("button:not([data-action='minimize']):not([data-action='show-results']):not([data-action='show-logs']):not([data-action='toggle-bottom'])").forEach((button) => { button.disabled = state.isBusy; });
    const driveInput = state.root.querySelector("[data-role='drive-urls']");
    if (driveInput) driveInput.disabled = state.isBusy;
    const minimizeButton = state.root.querySelector("[data-action='minimize']");
    minimizeButton.title = "最小化";
    minimizeButton.setAttribute("aria-label", "最小化");
    const successCount = getSuccessfulRecords().length;
    const failedCount = state.records.filter((record) => record.error || !record.transcript).length;
    state.root.querySelector("[data-role='record-count']").textContent = String(state.records.length);
    state.root.querySelector("[data-role='success-count']").textContent = String(successCount);
    state.root.querySelector("[data-role='failed-count']").textContent = String(failedCount);
    state.root.querySelector("[data-action='copy']").textContent = state.translateEnabled ? "复制三列结果" : "复制两列结果";
    renderBottomPanel();
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
    container.innerHTML = state.logs.length
      ? state.logs.map((entry) => `<p><span>${escapeHtml(entry.kind)}</span>${escapeHtml(entry.message)}<time>${escapeHtml(entry.time)}</time></p>`).join("")
      : "<div class=\"nlm-empty-state\">暂无操作日志。</div>";
  }

  function renderResults() {
    if (!state.root) return;
    const container = state.root.querySelector("[data-role='results']");
    if (!state.records.length) {
      container.innerHTML = "<p>尚无来源记录。</p>";
      return;
    }
    const cards = state.records.map((record, index) => {
      const statusClass = record.error ? "is-error" : record.sourceDeleted ? "is-removed" : "is-ready";
      const statusText = record.error ? "提取失败" : record.sourceDeleted ? "来源已移除" : "已提取";
      const transcript = record.error
        ? `<div class="nlm-result-error">${escapeHtml(record.error)}</div>`
        : `<pre>${escapeHtml(record.transcript || "")}</pre>`;
      const translation = state.translateEnabled
        ? `<section class="nlm-result-content"><span>中文翻译</span>${record.translationError
          ? `<div class="nlm-result-error">${escapeHtml(record.translationError)}</div>`
          : `<pre>${escapeHtml(record.translation || "等待翻译…")}</pre>`}</section>`
        : "";
      return `<article class="nlm-result-card">
        <header><div><b>${escapeHtml(record.sourceName || "未命名来源")}</b><small>来源 ${index + 1}</small></div><span class="nlm-result-status ${statusClass}">${statusText}</span></header>
        <div class="nlm-result-grid ${state.translateEnabled ? "has-translation" : ""}">
          <section class="nlm-result-content"><span>完整转录文字</span>${transcript}</section>
          ${translation}
        </div>
      </article>`;
    }).join("");
    container.innerHTML = `<div class="nlm-result-list">${cards}</div>`;
  }

  function renderBottomPanel() {
    if (!state.root) return;
    const panel = state.root.querySelector(".nlm-bottom-panel");
    if (!panel) return;
    panel.classList.toggle("is-open", state.bottomOpen);
    const resultButton = panel.querySelector("[data-action='show-results']");
    const logButton = panel.querySelector("[data-action='show-logs']");
    const toggleButton = panel.querySelector("[data-action='toggle-bottom']");
    const showingResults = state.bottomView === "results";
    resultButton.classList.toggle("is-active", showingResults);
    logButton.classList.toggle("is-active", !showingResults);
    resultButton.setAttribute("aria-selected", String(showingResults));
    logButton.setAttribute("aria-selected", String(!showingResults));
    panel.querySelector("[data-role='results-view']").classList.toggle("is-active", showingResults);
    panel.querySelector("[data-role='logs-view']").classList.toggle("is-active", !showingResults);
    panel.querySelector("[data-role='result-tab-count']").textContent = String(state.records.length);
    panel.querySelector("[data-role='log-tab-count']").textContent = String(state.logs.length);
    toggleButton.textContent = state.bottomOpen ? "⌄" : "⌃";
    toggleButton.title = state.bottomOpen ? "折叠底部面板" : "展开底部面板";
    toggleButton.setAttribute("aria-label", toggleButton.title);
  }

  function switchBottomView(view) {
    state.bottomView = view === "logs" ? "logs" : "results";
    state.bottomOpen = true;
    renderBottomPanel();
  }

  function toggleBottomPanel() {
    state.bottomOpen = !state.bottomOpen;
    renderBottomPanel();
  }

  function clearRecords() {
    const count = state.records.length;
    state.records = [];
    setStage(count ? `已清除 ${count} 条记录，可重新提取` : "当前没有可清除的记录");
    if (count) addLog(`已手动清除 ${count} 条会话记录；下次提取将重新读取全部来源。`, "清除");
    render();
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
        autoDeleteImported: state.autoDeleteImported,
        minimized: state.minimized,
        layout: state.panelLayout
      }
    });
  }

  function brandIconMarkup(className) {
    return `<img class="${className}" src="${chrome.runtime.getURL("assets/icon-128.png")}" alt="">`;
  }
})();
