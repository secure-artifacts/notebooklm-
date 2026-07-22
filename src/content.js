(function () {
  "use strict";

  const APP_ID = "nlm-video-translation-helper";
  const PANEL_SETTINGS_KEY = "nlmTranscriptPanelSettings";
  const SHEET_SETTINGS_KEY = "nlmSheetApiSettings";
  const API_TIMEOUT_MS = 10 * 60 * 1000;
  const MEDIA_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
  const BATCH_EXTRACTION_TIMEOUT_MS = 30 * 60 * 1000;
  const PAGE_RESPONSE_GRACE_MS = 15 * 1000;
  const DRIVE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
  const DEFAULT_DRIVE_BATCH_SIZE = 10;
  const MIN_DRIVE_BATCH_SIZE = 1;
  const MAX_DRIVE_BATCH_SIZE = 25;
  const DRIVE_PIPELINE_CONCURRENCY = 3;
  const DRIVE_DOWNLOAD_MAX_ATTEMPTS = 3;
  const DRIVE_RETRY_BASE_DELAY_MS = 1000;
  const SHEET_REGISTRATION_BATCH_SIZE = 200;
  const AI_TRANSLATION_BATCH_SIZE = 10;
  const AI_TRANSLATION_TIMEOUT_MS = 5 * 60 * 1000;
  const AI_TRANSLATION_RETRY_LIMIT = 1;
  const AI_TRANSLATION_SPLIT_SIZE = 5;
  const AI_TRANSLATION_POLL_MS = 500;
  const AI_TRANSLATION_SETTLE_MS = 1400;
  const MAX_LOGS = 240;
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
    driveBatchSize: DEFAULT_DRIVE_BATCH_SIZE,
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
  const activeDriveUploads = new Map();
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
    state.translateEnabled = panelSettings.aiTranslationEnabled === true;
    state.autoDeleteImported = panelSettings.autoDeleteImported !== false;
    state.driveBatchSize = normalizeDriveBatchSize(panelSettings.driveBatchSize);
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
    activeDriveUploads.clear();
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
          <label class="nlm-translate-toggle"><input type="checkbox" data-role="translate-toggle"><span>AI 翻译</span></label>
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
              <div class="nlm-drive-import-actions">
                <small>每批上传后立即提取；开启自动移除时释放名额。</small>
                <label class="nlm-batch-size"><span>每批</span><input type="number" data-role="drive-batch-size" min="1" max="25" step="1" inputmode="numeric"><span>个</span></label>
                <button type="button" data-action="import-drive">开始导入</button>
              </div>
            </div>
          </details>
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
          <div class="nlm-cleanup-row">
            <label class="nlm-auto-delete-toggle">
              <input type="checkbox" data-role="auto-delete-toggle">
              <span><b>自动移除导入来源</b><small>成功取得转录后释放来源名额</small></span>
            </label>
            <button type="button" data-action="delete-all-sources">清空左侧来源</button>
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
        setStage(state.translateEnabled ? "AI 翻译已开启" : "AI 翻译已关闭");
      }
    });
    state.root.querySelector("[data-role='auto-delete-toggle']").addEventListener("change", async (event) => {
      state.autoDeleteImported = event.target.checked;
      setStage(state.autoDeleteImported ? "自动移除已开启" : "自动移除已关闭");
      render();
      await savePanelSettings();
    });
    state.root.querySelector("[data-role='drive-batch-size']").addEventListener("change", async (event) => {
      state.driveBatchSize = normalizeDriveBatchSize(event.target.value);
      event.target.value = String(state.driveBatchSize);
      setStage(`Drive 每批处理 ${state.driveBatchSize} 个文件`);
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
      if (payload && /上传临时失败/.test(String(payload.stage || ""))) {
        addLog(payload.stage, "自动重试");
      }
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
      pending.receivedBytes = received;
      pending.totalBytes = total;
      refreshDriveActivity();
      return;
    }
    if (type !== "drive-download-response") return;

    pendingDriveDownloads.delete(requestId);
    clearTimeout(pending.timeoutId);
    refreshDriveActivity();
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

    const batchInput = state.root.querySelector("[data-role='drive-batch-size']");
    state.driveBatchSize = normalizeDriveBatchSize(batchInput && batchInput.value);
    if (batchInput) batchInput.value = String(state.driveBatchSize);
    await savePanelSettings();

    state.isBusy = true;
    state.logs = [];
    state.bottomOpen = true;
    state.bottomView = "logs";
    const totalBatches = Math.ceil(urls.length / state.driveBatchSize);
    addLog(`准备导入 ${urls.length} 个公开 Drive 文件：共 ${totalBatches} 批，每批最多 ${state.driveBatchSize} 个。`, "导入");
    if (!state.autoDeleteImported && totalBatches > 1) {
      addLog("自动移除已关闭；多批次来源会持续占用当前笔记本名额，达到上限后后续上传可能失败。", "提醒");
    }
    render();

    let succeeded = 0;
    let failed = 0;
    let processingFailed = 0;
    let transcriptsAdded = 0;
    let autoDeleted = 0;

    try {
      await ensureDriveLoader();
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
        const batchStart = batchIndex * state.driveBatchSize;
        const batchUrls = urls.slice(batchStart, batchStart + state.driveBatchSize);
        const batchLabel = `${batchIndex + 1}/${totalBatches}`;
        setStage(`正在处理批次 ${batchLabel}（${batchUrls.length} 个文件）…`);
        addLog(`批次 ${batchLabel} 开始：${batchUrls.length} 个文件。`, "批次");

        const uploadSummary = await uploadDriveBatch(batchUrls, batchStart, urls.length);
        succeeded += uploadSummary.succeeded;
        failed += uploadSummary.failed;

        const extractionSummary = await extractDriveBatch(uploadSummary.uploadedSources, batchLabel);
        transcriptsAdded += extractionSummary.transcriptsAdded;
        processingFailed += extractionSummary.processingFailed;

        let translationSummary = emptyTranslationSummary();
        if (state.translateEnabled && extractionSummary.extractedSourceIds.length) {
          setStage(`批次 ${batchLabel}：正在进行 AI 翻译…`);
          translationSummary = await translateRecords({ sourceIds: extractionSummary.extractedSourceIds });
        }

        const deletionCandidates = state.translateEnabled
          ? translationSummary.translatedSourceIds
          : extractionSummary.extractedSourceIds;
        let batchDeleted = 0;
        if (state.autoDeleteImported && deletionCandidates.length) {
          batchDeleted = await deleteImportedBatch(deletionCandidates, batchLabel);
          autoDeleted += batchDeleted;
        }

        const retainedSources = Math.max(0, uploadSummary.uploadedSources.length - batchDeleted);
        if (state.autoDeleteImported && retainedSources) {
          addLog(
            `批次 ${batchLabel} 仍保留 ${retainedSources} 个来源（转录或自动移除未成功），会继续占用 NotebookLM 来源名额。`,
            "提醒"
          );
        }

        addLog(
          `批次 ${batchLabel} 完成：上传成功 ${uploadSummary.succeeded}，上传失败 ${uploadSummary.failed}，` +
          `转录成功 ${extractionSummary.transcriptsAdded}，转录失败 ${extractionSummary.processingFailed}，` +
          `AI 翻译成功 ${translationSummary.translated}，失败 ${translationSummary.failed}，自动移除 ${batchDeleted}。`,
          "批次汇总"
        );
        render();
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
      activeDriveUploads.clear();
      state.isBusy = false;
      render();
    }
  }

  async function uploadDriveBatch(batchUrls, batchStart, totalUrls) {
    const startedAt = Date.now();
    const results = new Array(batchUrls.length);
    const workerCount = Math.min(DRIVE_PIPELINE_CONCURRENCY, batchUrls.length);
    let nextIndex = 0;

    async function worker() {
      while (true) {
        const localIndex = nextIndex;
        nextIndex += 1;
        if (localIndex >= batchUrls.length) return;
        try {
          results[localIndex] = await importOneDriveFile(
            batchUrls[localIndex],
            batchStart + localIndex,
            totalUrls
          );
        } catch (error) {
          const position = `${batchStart + localIndex + 1}/${totalUrls}`;
          addLog(`${position} 未预期错误：${error.message || String(error)}`, "导入失败");
          results[localIndex] = { ok: false };
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const uploadedSources = results
      .filter((result) => result && result.ok && result.sourceId)
      .map((result) => ({ sourceId: result.sourceId, fileName: result.fileName }));
    const succeeded = uploadedSources.length;
    const failed = results.length - succeeded;
    addLog(
      `本批下载与上传完成：${workerCount} 路受控并发，成功 ${succeeded}，失败 ${failed}，耗时 ${formatDuration(Date.now() - startedAt)}。`,
      "上传汇总"
    );
    return { uploadedSources, succeeded, failed };
  }

  async function importOneDriveFile(url, globalIndex, totalUrls) {
    const position = `${globalIndex + 1}/${totalUrls}`;
    let file;
    try {
      file = await downloadDriveMediaWithRetry(url, position);
      const mediaKind = file.type.startsWith("video/") ? "视频" : "音频";
      addLog(`${position} 已识别${mediaKind}：${file.name}（${file.type}，${formatBytes(file.size)}）`, "下载");
    } catch (error) {
      addLog(`${position} ${error.message || String(error)}`, "下载失败");
      return { ok: false };
    }

    const activityId = `${globalIndex}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeDriveUploads.set(activityId, { position, fileName: file.name });
    refreshDriveActivity();
    try {
      const result = await callPageApi("upload-media-source", {
        file,
        options: { timeoutMs: MEDIA_UPLOAD_TIMEOUT_MS, pollIntervalMs: 3000 }
      }, MEDIA_UPLOAD_TIMEOUT_MS);
      if (!result || !result.sourceId) {
        throw new Error("NotebookLM 已接收文件，但未返回可用于提取的来源标识。");
      }
      addLog(`${position} 已加入 NotebookLM：${file.name}`, "成功");
      return { ok: true, sourceId: result.sourceId, fileName: result.fileName || file.name };
    } catch (error) {
      addLog(`${position} ${error.message || String(error)}`, "上传失败");
      return { ok: false };
    } finally {
      activeDriveUploads.delete(activityId);
      refreshDriveActivity();
      render();
    }
  }

  async function extractDriveBatch(uploadedSources, batchLabel) {
    if (!uploadedSources.length) {
      return { transcriptsAdded: 0, processingFailed: 0, extractedSourceIds: [] };
    }

    setStage(`批次 ${batchLabel}：等待 ${uploadedSources.length} 个来源生成转录…`);
    addLog(`批次 ${batchLabel} 上传结束，开始等待并提取 ${uploadedSources.length} 个新增来源。`, "提取");
    try {
      const sourceNames = Object.fromEntries(uploadedSources.map((item) => [item.sourceId, item.fileName]));
      const result = await callPageApi("extract-existing-sources", {
        sourceIds: uploadedSources.map((item) => item.sourceId),
        sourceNames,
        waitForReady: true,
        timeoutMs: BATCH_EXTRACTION_TIMEOUT_MS - PAGE_RESPONSE_GRACE_MS,
        overallTimeoutMs: BATCH_EXTRACTION_TIMEOUT_MS - PAGE_RESPONSE_GRACE_MS,
        pollIntervalMs: 3000
      }, BATCH_EXTRACTION_TIMEOUT_MS);
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
      const transcriptsAdded = mergeRecords(importedRecords);
      const processingFailed = importedRecords.filter((record) => record.error || !record.transcript).length;
      const extractedSourceIds = importedRecords
        .filter((record) => record.sourceId && record.transcript && !record.error)
        .map((record) => record.sourceId);
      importedRecords.filter((record) => record.error).forEach((record) => {
        addLog(`${record.sourceName || record.sourceId}：${record.error}`, "转录失败");
      });
      return { transcriptsAdded, processingFailed, extractedSourceIds };
    } catch (error) {
      const message = error.message || String(error);
      const failedRecords = uploadedSources.map((item) => ({
        sourceId: item.sourceId,
        sourceName: item.fileName,
        transcript: "",
        error: message
      }));
      mergeRecords(failedRecords);
      addLog(`批次 ${batchLabel} 文件已上传，但提取转录失败：${message}`, "转录失败");
      return { transcriptsAdded: 0, processingFailed: failedRecords.length, extractedSourceIds: [] };
    }
  }

  async function deleteImportedBatch(sourceIds, batchLabel) {
    setStage(`批次 ${batchLabel}：正在移除 ${sourceIds.length} 个已完成来源…`);
    try {
      const deletion = await deleteNotebookSources(sourceIds);
      markSourcesDeleted(deletion.deleted);
      addLog(`批次 ${batchLabel} 自动移除成功 ${deletion.deleted.length} 个；失败 ${deletion.failed.length} 个。`, "来源清理");
      deletion.failed.forEach((item) => addLog(`${item.sourceName || item.sourceId}：${item.error}`, "移除失败"));
      return deletion.deleted.length;
    } catch (error) {
      addLog(`批次 ${batchLabel} 转录已保留，但自动移除失败：${error.message || String(error)}`, "移除失败");
      return 0;
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

  async function downloadDriveMediaWithRetry(url, position) {
    let lastError;
    for (let attempt = 1; attempt <= DRIVE_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await downloadDriveMedia(url, position);
      } catch (error) {
        lastError = error;
        if (attempt >= DRIVE_DOWNLOAD_MAX_ATTEMPTS || !isRetryableDriveError(error)) break;
        const delayMs = DRIVE_RETRY_BASE_DELAY_MS * attempt;
        addLog(`${position} 下载临时失败，${Math.ceil(delayMs / 1000)} 秒后重试（${attempt + 1}/${DRIVE_DOWNLOAD_MAX_ATTEMPTS}）。`, "自动重试");
        await wait(delayMs);
      }
    }
    throw lastError || new Error("Drive 文件下载失败。");
  }

  function isRetryableDriveError(error) {
    const message = String(error && error.message ? error.message : error || "");
    const statusMatch = message.match(/HTTP\s+(\d{3})/i);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
    return /超时|failed to fetch|network|connection|temporar/i.test(message);
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
        refreshDriveActivity();
        reject(new Error("Drive 文件下载超时。"));
      }, DRIVE_DOWNLOAD_TIMEOUT_MS);
      pendingDriveDownloads.set(requestId, { resolve, reject, timeoutId, position, receivedBytes: 0, totalBytes: 0 });
      refreshDriveActivity();
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

  function normalizeDriveBatchSize(value) {
    const parsed = Number.parseInt(String(value || ""), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_DRIVE_BATCH_SIZE;
    return Math.max(MIN_DRIVE_BATCH_SIZE, Math.min(MAX_DRIVE_BATCH_SIZE, parsed));
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

  function formatDuration(value) {
    const seconds = Math.max(0, Math.round((Number(value) || 0) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
  }

  function refreshDriveActivity() {
    const downloads = Array.from(pendingDriveDownloads.values());
    const receivedBytes = downloads.reduce((sum, item) => sum + (Number(item.receivedBytes) || 0), 0);
    const totalBytes = downloads.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0);
    state.driveActivity.download = downloads.length
      ? `下载中 ${downloads.length} 个 · ${formatBytes(receivedBytes)}${totalBytes ? `/${formatBytes(totalBytes)}` : ""}`
      : "";
    state.driveActivity.upload = activeDriveUploads.size ? `上传中 ${activeDriveUploads.size} 个` : "";
    const stages = [state.driveActivity.upload, state.driveActivity.download].filter(Boolean);
    if (stages.length) setStage(stages.join(" · "));
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
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
        sourceOriginalName: String(incoming.sourceName || "").trim(),
        sourceName: stripSourceSuffix(incoming.sourceName)
      };
      const existingIndex = record.sourceId
        ? state.records.findIndex((item) => item.sourceId === record.sourceId)
        : -1;
      if (existingIndex >= 0) {
        state.records[existingIndex] = {
          ...state.records[existingIndex],
          ...record,
          sourceOriginalName: record.sourceOriginalName || state.records[existingIndex].sourceOriginalName || state.records[existingIndex].sourceName
        };
      }
      else state.records.push(record);
      if (record.transcript && !record.error) transcriptCount += 1;
    });
    return transcriptCount;
  }

  async function translateExistingRecords() {
    state.isBusy = true;
    state.bottomOpen = true;
    state.bottomView = "results";
    render();
    try {
      const summary = await translateRecords();
      setStage(summary.failed
        ? `AI 翻译完成：成功 ${summary.translated}，失败 ${summary.failed}`
        : summary.translated
        ? `AI 翻译完成：成功 ${summary.translated}`
        : "没有可进行 AI 翻译的来源");
    } finally {
      state.isBusy = false;
      render();
    }
  }

  async function translateRecords(options = {}) {
    const requestedSourceIds = new Set(Array.isArray(options.sourceIds) ? options.sourceIds.filter(Boolean) : []);
    const records = state.records.filter((record) => {
      if (!record.transcript || record.error || record.translation) return false;
      return !requestedSourceIds.size || requestedSourceIds.has(record.sourceId);
    });
    const summary = emptyTranslationSummary();
    if (!records.length) return summary;

    const originalSelection = captureNotebookSourceSelection();
    try {
      for (let offset = 0; offset < records.length; offset += AI_TRANSLATION_BATCH_SIZE) {
        const batch = records.slice(offset, offset + AI_TRANSLATION_BATCH_SIZE);
        const batchLabel = `${Math.floor(offset / AI_TRANSLATION_BATCH_SIZE) + 1}/${Math.ceil(records.length / AI_TRANSLATION_BATCH_SIZE)}`;
        setStage(`AI 翻译批次 ${batchLabel}（${batch.length} 个来源）…`);
        addLog(`AI 翻译批次 ${batchLabel}：准备 ${batch.length} 个已有转录来源。`, "AI 翻译");
        const batchSummary = await translateAiBatchWithRecovery(batch, batchLabel);
        summary.translated += batchSummary.translated;
        summary.failed += batchSummary.failed;
        summary.translatedSourceIds.push(...batchSummary.translatedSourceIds);
        render();
      }
    } finally {
      restoreNotebookSourceSelection(originalSelection);
    }
    return summary;
  }

  function emptyTranslationSummary() {
    return { translated: 0, failed: 0, translatedSourceIds: [] };
  }

  async function translateAiBatchWithRecovery(records, batchLabel, allowSplit = true) {
    const summary = emptyTranslationSummary();
    let pending = records.slice();
    let lastError = "";

    for (let attempt = 0; pending.length && attempt <= AI_TRANSLATION_RETRY_LIMIT; attempt += 1) {
      try {
        const sourceControls = selectNotebookSourcesForRecords(pending);
        if (sourceControls.missing.length) {
          sourceControls.missing.forEach((record) => {
            record.translationError = "当前 NotebookLM 中找不到该来源，可能已自动移除；无法进行 AI 翻译。";
            addLog(`${record.sourceName || "未命名来源"}：${record.translationError}`, "AI 翻译跳过");
          });
          summary.failed += sourceControls.missing.length;
          pending = sourceControls.selected;
        }
        if (!pending.length) break;

        await wait(220);
        if (!notebookSourcesAreSelected(pending)) {
          throw new Error("NotebookLM 未能切换到当前翻译来源，请重试。");
        }
        const payload = await submitNotebookAiTranslationPrompt();
        const result = mergeAiTranslationPayload(payload, pending);
        summary.translated += result.translated.length;
        summary.translatedSourceIds.push(...result.translated.map((record) => record.sourceId).filter(Boolean));
        pending = result.missing;
        if (result.unknown.length) {
          addLog(`批次 ${batchLabel} 返回 ${result.unknown.length} 条无法匹配的来源，已忽略。`, "AI 翻译校验");
        }
        if (pending.length) {
          addLog(`批次 ${batchLabel} 仍缺少 ${pending.length} 条翻译，将仅重试缺少来源。`, "AI 翻译重试");
        }
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        addLog(`批次 ${batchLabel} 第 ${attempt + 1} 次请求失败：${lastError}`, "AI 翻译失败");
      }
    }

    if (pending.length && allowSplit && pending.length > AI_TRANSLATION_SPLIT_SIZE) {
      addLog(`批次 ${batchLabel} 未完成 ${pending.length} 条，拆分为最多 ${AI_TRANSLATION_SPLIT_SIZE} 条后重试。`, "AI 翻译恢复");
      for (let index = 0; index < pending.length; index += AI_TRANSLATION_SPLIT_SIZE) {
        const child = await translateAiBatchWithRecovery(
          pending.slice(index, index + AI_TRANSLATION_SPLIT_SIZE),
          `${batchLabel}.${Math.floor(index / AI_TRANSLATION_SPLIT_SIZE) + 1}`,
          false
        );
        summary.translated += child.translated;
        summary.failed += child.failed;
        summary.translatedSourceIds.push(...child.translatedSourceIds);
      }
      return summary;
    }

    pending.forEach((record) => {
      record.translationError = lastError || "NotebookLM 未返回该来源的完整中文翻译。";
      addLog(`${record.sourceName || "未命名来源"}：${record.translationError}`, "AI 翻译失败");
    });
    summary.failed += pending.length;
    return summary;
  }

  function captureNotebookSourceSelection() {
    return getNotebookSourceControls().map((control) => ({ name: control.name, checked: control.checkbox.checked }));
  }

  function restoreNotebookSourceSelection(snapshot) {
    if (!Array.isArray(snapshot)) return;
    const desiredByName = new Map(snapshot.map((item) => [item.name, Boolean(item.checked)]));
    getNotebookSourceControls().forEach((control) => {
      if (!desiredByName.has(control.name)) return;
      const desired = desiredByName.get(control.name);
      if (control.checkbox.checked !== desired) control.checkbox.click();
    });
  }

  function getNotebookSourceControls() {
    return Array.from(document.querySelectorAll(".single-source-container"))
      .map((container) => {
        const button = container.querySelector("button.source-stretched-button[aria-label]");
        const checkbox = container.querySelector('input[type="checkbox"]');
        return { container, button, checkbox, name: button ? String(button.getAttribute("aria-label") || "").trim() : "" };
      })
      .filter((item) => item.name && item.checkbox);
  }

  function selectNotebookSourcesForRecords(records) {
    const controls = getNotebookSourceControls();
    const available = controls.slice();
    const selected = [];
    const missing = [];
    records.forEach((record) => {
      const matchIndex = available.findIndex((control) => sourceNamesMatch(control.name, record.sourceOriginalName || record.sourceName));
      if (matchIndex < 0) {
        missing.push(record);
        return;
      }
      const [control] = available.splice(matchIndex, 1);
      selected.push(record);
      record._aiSourceControlName = control.name;
    });

    const targetNames = new Set(selected.map((record) => record._aiSourceControlName));
    controls.forEach((control) => {
      const shouldSelect = targetNames.has(control.name);
      if (control.checkbox.checked !== shouldSelect) control.checkbox.click();
    });
    return { selected, missing };
  }

  function sourceNamesMatch(left, right) {
    const normalize = (value) => stripSourceSuffix(String(value || "")).replace(/\s+/g, " ").trim().toLocaleLowerCase();
    return Boolean(left && right && normalize(left) === normalize(right));
  }

  function notebookSourcesAreSelected(records) {
    const selectedNames = new Set(records.map((record) => record._aiSourceControlName));
    return selectedNames.size === records.length && getNotebookSourceControls().every((control) => control.checkbox.checked === selectedNames.has(control.name));
  }

  async function submitNotebookAiTranslationPrompt() {
    const chatPanel = document.querySelector(".chat-panel");
    const input = document.querySelector('textarea[aria-label="查询框"]');
    if (!chatPanel || !input) throw new Error("未找到 NotebookLM 对话框，请刷新页面后重试。");
    const knownPayloads = new Set(getNotebookAiResponseTexts(chatPanel)
      .flatMap((text) => extractJsonArrayCandidates(text).map((item) => item.raw)));
    const prompt = buildAiTranslationPrompt();
    setNativeTextareaValue(input, prompt);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const submit = document.querySelector('button[type="submit"][aria-label="提交"]');
    const ready = await waitForCondition(() => submit && !submit.disabled, 6000, 100);
    if (!ready) throw new Error("NotebookLM 未能启用发送按钮，请确认页面已加载完成。");
    submit.click();
    return waitForNotebookAiJson(chatPanel, knownPayloads);
  }

  function buildAiTranslationPrompt() {
    return [
      "请将当前选中的全部来源分别完整翻译成中文。",
      "不得概括、删减、合并来源。",
      "请仅输出合法 JSON 数组，不要使用 Markdown 代码块，不要解释。",
      "格式必须完全为：",
      '[{"source_name":"来源名","zh":"完整中文翻译"}]'
    ].join("\n");
  }

  function setNativeTextareaValue(textarea, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (!descriptor || typeof descriptor.set !== "function") throw new Error("无法写入 NotebookLM 对话框。");
    descriptor.set.call(textarea, value);
  }

  async function waitForNotebookAiJson(chatPanel, knownPayloads) {
    const deadline = Date.now() + AI_TRANSLATION_TIMEOUT_MS;
    let stableRaw = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      const candidates = getNotebookAiResponseTexts(chatPanel)
        .flatMap((text) => extractJsonArrayCandidates(text))
        .filter((item) => !knownPayloads.has(item.raw))
        .filter((item) => item.value.some((row) => row && typeof row === "object" && typeof row.source_name === "string" && typeof row.zh === "string" && row.zh.trim() && row.zh.trim() !== "完整中文翻译"));
      const newest = candidates[candidates.length - 1];
      if (newest) {
        if (newest.raw !== stableRaw) {
          stableRaw = newest.raw;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= AI_TRANSLATION_SETTLE_MS) {
          return newest.value;
        }
      }
      await wait(AI_TRANSLATION_POLL_MS);
    }
    throw new Error("等待 NotebookLM AI 翻译超时，未收到完整 JSON 结果。");
  }

  function getNotebookAiResponseTexts(chatPanel) {
    return Array.from(chatPanel.querySelectorAll(".to-user-message-inner-content"))
      .map((message) => {
        const content = message.querySelector(".message-text-content") || message;
        const clone = content.cloneNode(true);
        clone.querySelectorAll(".citation-marker").forEach((marker) => marker.remove());
        return String(clone.textContent || "").trim();
      })
      .filter(Boolean);
  }

  function extractJsonArrayCandidates(text) {
    const source = String(text || "");
    const candidates = [];
    for (let start = source.indexOf("["); start >= 0; start = source.indexOf("[", start + 1)) {
      let depth = 0;
      let quote = "";
      let escaped = false;
      for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === quote) quote = "";
          continue;
        }
        if (char === '"') {
          quote = char;
          continue;
        }
        if (char === "[") depth += 1;
        else if (char === "]") {
          depth -= 1;
          if (!depth) {
            const raw = source.slice(start, index + 1);
            try {
              const value = JSON.parse(raw);
              if (Array.isArray(value)) candidates.push({ raw, value });
            } catch (_error) {
              // Keep scanning: streamed answers are often incomplete before the final update.
            }
            break;
          }
        }
      }
    }
    return candidates;
  }

  function mergeAiTranslationPayload(payload, records) {
    const unmatchedRecords = records.slice();
    const translated = [];
    const unknown = [];
    (Array.isArray(payload) ? payload : []).forEach((item) => {
      if (!item || typeof item !== "object" || typeof item.source_name !== "string" || typeof item.zh !== "string" || !item.zh.trim()) {
        unknown.push(item);
        return;
      }
      const index = unmatchedRecords.findIndex((record) => sourceNamesMatch(item.source_name, record.sourceOriginalName || record.sourceName));
      if (index < 0) {
        unknown.push(item);
        return;
      }
      const [record] = unmatchedRecords.splice(index, 1);
      record.translation = item.zh.trim();
      record.translationError = "";
      translated.push(record);
    });
    return { translated, missing: unmatchedRecords, unknown };
  }

  function waitForCondition(check, timeoutMs, intervalMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = () => {
        if (check()) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(poll, intervalMs);
      };
      poll();
    });
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
    const records = available.map((record) => ({
      post_id: sourceNameToPostId(record.sourceName),
      audio_content: record.transcript,
      audio_content_zh: record.translation || ""
    }));
    const totalBatches = Math.ceil(records.length / SHEET_REGISTRATION_BATCH_SIZE);
    const statusCounts = Object.create(null);
    const failureLogs = [];
    let totalSuccess = 0;
    let totalFailed = 0;

    try {
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
        const batchStart = batchIndex * SHEET_REGISTRATION_BATCH_SIZE;
        const batchRecords = records.slice(batchStart, batchStart + SHEET_REGISTRATION_BATCH_SIZE);
        const batchLabel = `${batchIndex + 1}/${totalBatches}`;
        setStage(`正在登记批次 ${batchLabel}（${batchRecords.length} 条）…`);
        addLog(`批次 ${batchLabel} 已发送，共 ${batchRecords.length} 条。`, "登记");
        render();

        try {
          const result = await callSheetUpsert(settings.deploymentUrl, databaseUrl, batchRecords);
          if (!result || result.ok !== true) {
            const apiError = (result && result.error) || {};
            const status = (result && result.http_status) || "未知";
            const requestId = (result && result.request_id) || "无";
            totalFailed += batchRecords.length;
            addStatusCount(statusCounts, "request_failed", batchRecords.length);
            failureLogs.push({
              title: `批次 ${batchLabel} 请求失败`,
              message: [
                `HTTP ${status} · request_id: ${requestId}`,
                `${apiError.code || "UNKNOWN"}：${apiError.message || "服务未返回具体原因"}`,
                `未登记 post_id：${batchRecords.map((record) => record.post_id).join("、")}`
              ].join("\n")
            });
            addLog(`批次 ${batchLabel} 请求失败，已继续下一批。`, "登记失败");
            continue;
          }

          const summary = (result.data && result.data.summary) || {};
          const outcomes = Array.isArray(result.data && result.data.results) ? result.data.results : [];
          mergeStatusCounts(statusCounts, summary.status_counts);

          const outcomeSuccess = outcomes.filter((outcome) => outcome && outcome.success === true).length;
          const outcomeFailed = outcomes.filter((outcome) => outcome && outcome.success === false).length;
          let batchSuccess = parseStatusCount(summary.success, outcomeSuccess);
          let batchFailed = parseStatusCount(summary.failed, outcomeFailed);
          batchSuccess = Math.min(batchRecords.length, batchSuccess);
          batchFailed = Math.min(batchRecords.length - batchSuccess, batchFailed);

          const unaccounted = batchRecords.length - batchSuccess - batchFailed;
          if (unaccounted > 0) {
            batchFailed += unaccounted;
            addStatusCount(statusCounts, "unreported_result", unaccounted);
            const reportedIndexes = new Set(outcomes
              .map((outcome) => Number(outcome && outcome.index))
              .filter((index) => Number.isInteger(index) && index >= 0 && index < batchRecords.length));
            const missingPostIds = batchRecords
              .filter((_record, index) => !reportedIndexes.has(index))
              .map((record) => record.post_id);
            failureLogs.push({
              title: `批次 ${batchLabel} 返回不完整`,
              message: `服务未返回 ${unaccounted} 条记录的结果。未确认 post_id：${missingPostIds.join("、") || "无法确定"}`
            });
          }

          totalSuccess += batchSuccess;
          totalFailed += batchFailed;
          outcomes.filter((outcome) => outcome && outcome.success === false).forEach((outcome) => {
            const localIndex = Number(outcome.index);
            const original = Number.isInteger(localIndex) ? batchRecords[localIndex] : null;
            const postId = outcome.post_id || (original && original.post_id) || `总第 ${batchStart + (Number.isInteger(localIndex) ? localIndex : 0) + 1} 条`;
            const error = outcome.error || {};
            const code = error.code ? ` [${error.code}]` : "";
            failureLogs.push({
              title: "失败",
              message: `${postId}${code}：${error.message || "处理失败（服务未返回具体原因）"}`
            });
          });
          addLog(`批次 ${batchLabel} 完成：成功 ${batchSuccess}，失败 ${batchFailed}。`, "批次汇总");
        } catch (error) {
          const details = error.details || {};
          totalFailed += batchRecords.length;
          addStatusCount(statusCounts, "request_failed", batchRecords.length);
          failureLogs.push({
            title: `批次 ${batchLabel} 请求失败`,
            message: [
              `error.code: ${details.code || "REQUEST_FAILED"}`,
              `http_status: ${details.http_status || "未知"}`,
              `message: ${error.message || String(error)}`,
              details.response_preview ? `response_preview: ${details.response_preview}` : "",
              `未登记 post_id：${batchRecords.map((record) => record.post_id).join("、")}`
            ].filter(Boolean).join("\n")
          });
          addLog(`批次 ${batchLabel} 请求异常，已继续下一批。`, "登记失败");
        }
        render();
      }

      const logTime = new Date().toLocaleTimeString();
      const visibleFailures = failureLogs.slice(0, Math.max(0, MAX_LOGS - 3));
      const hiddenFailureCount = failureLogs.length - visibleFailures.length;
      state.logs = [
        { message: formatStatusCounts(statusCounts), kind: "status_counts", time: logTime },
        { message: `共 ${records.length} 条，${totalBatches} 批；成功 ${totalSuccess}，失败 ${totalFailed}。`, kind: "登记汇总", time: logTime },
        ...(hiddenFailureCount ? [{ message: `失败明细较多，当前显示前 ${visibleFailures.length} 条，另有 ${hiddenFailureCount} 条未展开。`, kind: "显示限制", time: logTime }] : []),
        ...visibleFailures.map((entry) => ({ message: entry.message, kind: entry.title, time: logTime }))
      ].slice(0, MAX_LOGS);
      setStage(`登记完成：成功 ${totalSuccess}，失败 ${totalFailed}`);
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

  function callSheetUpsert(deploymentUrl, databaseUrl, records) {
    return sendBackgroundMessage({ type: "sheet-upsert", deploymentUrl, databaseUrl, records }).then((response) => {
      if (response && response.result) return response.result;
      const details = response && response.error;
      const error = new Error((details && details.message) || (typeof details === "string" ? details : "表格登记失败。"));
      error.details = details || null;
      throw error;
    });
  }

  function parseStatusCount(value, fallback = 0) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : fallback;
  }

  function addStatusCount(target, status, count) {
    const amount = parseStatusCount(count);
    if (!status || !amount) return;
    target[status] = (target[status] || 0) + amount;
  }

  function mergeStatusCounts(target, incoming) {
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return;
    Object.entries(incoming).forEach(([status, count]) => addStatusCount(target, status, count));
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
    const batchSizeInput = state.root.querySelector("[data-role='drive-batch-size']");
    if (batchSizeInput) {
      batchSizeInput.value = String(state.driveBatchSize);
      batchSizeInput.disabled = state.isBusy;
    }
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
        aiTranslationEnabled: state.translateEnabled,
        autoDeleteImported: state.autoDeleteImported,
        driveBatchSize: state.driveBatchSize,
        minimized: state.minimized,
        layout: state.panelLayout
      }
    });
  }

  function brandIconMarkup(className) {
    return `<img class="${className}" src="${chrome.runtime.getURL("assets/icon-128.png")}" alt="">`;
  }
})();
