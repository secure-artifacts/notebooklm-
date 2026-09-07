import {
  DEFAULT_AI_TRANSLATION_BATCH_SIZE,
  MAX_AI_TRANSLATION_BATCH_SIZE,
  MIN_AI_TRANSLATION_BATCH_SIZE,
  buildTranslationPrompt,
  extractJsonArrayCandidates,
  mergeTranslationPayload,
  normalizeAiTranslationBatchSize,
  sourceNamesMatch,
  stripSourceSuffix
} from "@/lib/aiTranslation";
import {
  formatBytes,
  formatDuration,
  isRetryableNetworkError as isRetryableDriveError,
  mapConcurrent,
  normalizeBatchSize,
  parseDriveUrls
} from "@/lib/driveImport";
import { completedSourceIdsForCleanup } from "@/lib/importCleanup";
import {
  isFacebookTableRowPopulated,
  parseFacebookClipboardRows,
  parseFacebookTableRows,
  shouldAppendFacebookEditorRow
} from "@/lib/colabProvider";
import {
  FACEBOOK_BATCH_SIZE,
  FACEBOOK_MAX_TASKS,
  NOTEBOOK_SOURCE_LIMIT,
  RESULT_RENDER_LIMIT,
  createFacebookJob,
  facebookTaskFingerprint,
  nextFacebookBatch,
  removeFacebookJobTasks,
  retainedSourceCapacity
} from "@/lib/facebookQueue";
import {
  addStatusCount,
  analyzeBatchResponse,
  chunkSheetRegistrationRecords,
  formatStatusCounts,
  isSheetRequestTooLarge,
  mergeStatusCounts,
  summarizeSheetPostIds,
  toSheetRecords,
  validDatabaseUrl,
  validDeploymentUrl
} from "@/lib/sheetRegistration";
import {
  captureSourceSelection,
  findChatInput,
  findChatPanel,
  findChatSubmit,
  getAiResponseTexts,
  getUserMessageTexts,
  isNotebookAiGenerating,
  restoreSourceSelection,
  selectSourcesForRecordsWhenReady,
  sourcesAreSelected
} from "@/lib/notebookDom";
import type { LogEntry, TranscriptRecord } from "@/types/domain";
import type { FacebookBulkJob } from "@/types/facebookJob";
import type {
  ExtensionResources,
  PanelLayout,
  PanelSettings
} from "@/types/messages";
import { extensionClient } from "@/scopes/content/extensionClient";
import { FacebookImportCoordinator } from "@/scopes/content/facebookCoordinator";
import { callNotebookPageApi } from "@/scopes/content/notebookClient";
import type { NotebookAction } from "./apiClient";

  const APP_ID = "nlm-video-translation-helper";
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
  const AI_TRANSLATION_TIMEOUT_MS = 15 * 60 * 1000;
  const AI_TRANSLATION_RETRY_LIMIT = 1;
  const AI_TRANSLATION_SPLIT_SIZE = 5;
  const AI_TRANSLATION_POLL_MS = 500;
  const AI_TRANSLATION_SETTLE_MS = 1400;

  class AiTranslationPageStateError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AiTranslationPageStateError";
    }
  }
  class AiTranslationPauseError extends Error {
    constructor() {
      super("已按请求暂停 AI 翻译");
      this.name = "AiTranslationPauseError";
    }
  }
  const MAX_LOGS = 240;
  const DRIVE_BRIDGE_TOKEN = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  type AppState = {
    records: TranscriptRecord[];
    isBusy: boolean;
    translateEnabled: boolean;
    translationBatchSize: number;
    autoDeleteImported: boolean;
    autoRegisterImported: boolean;
    driveBatchSize: number;
    importMode: "drive" | "facebook";
    facebookRows: FacebookInputRow[];
    facebookActive: boolean;
    databaseUrl: string;
    minimized: boolean;
    bottomOpen: boolean;
    bottomView: "results" | "logs";
    driveActivity: { download: string; upload: string };
    panelLayout: PanelLayout;
    suppressClick: boolean;
    stage: string;
    logs: LogEntry[];
    root: HTMLElement;
  };

  type FacebookStatusKind = "idle" | "working" | "success" | "error";

  type FacebookInputRow = {
    key: number;
    postId: string;
    url: string;
    transcriptStatus: string;
    transcriptStatusKind: FacebookStatusKind;
    translationStatus: string;
    translationStatusKind: FacebookStatusKind;
    selected: boolean;
    persistedTaskId?: string;
  };

  type PendingDriveDownload = {
    resolve: (file: File) => void;
    reject: (error: Error) => void;
    timeoutId: number;
    position: string;
    receivedBytes: number;
    totalBytes: number;
  };

  const state: AppState = {
    records: [],
    isBusy: false,
    translateEnabled: false,
    translationBatchSize: DEFAULT_AI_TRANSLATION_BATCH_SIZE,
    autoDeleteImported: true,
    autoRegisterImported: false,
    driveBatchSize: DEFAULT_DRIVE_BATCH_SIZE,
    importMode: "drive",
    facebookRows: [],
    facebookActive: false,
    databaseUrl: "",
    minimized: false,
    bottomOpen: true,
    bottomView: "results",
    driveActivity: { download: "", upload: "" },
    panelLayout: {},
    suppressClick: false,
    stage: "准备就绪",
    logs: [],
    root: null!
  };
  let extensionResources: ExtensionResources = {
    driveLoaderUrl: "",
    iconUrl: "",
    extensionOrigin: ""
  };
  const pendingDriveDownloads = new Map<string, PendingDriveDownload>();
  const activeDriveUploads = new Map<string, { position: string; fileName: string }>();
  let driveLoaderFrame: HTMLIFrameElement = null!;
  let driveLoaderReady: Promise<void> | null = null;
  let resolveDriveLoaderReady: (() => void) | null = null;
  let initialized = false;
  let activeNotebookId = "";
  let routeTimerId = 0;
  let facebookCoordinator: FacebookImportCoordinator | null = null;
  let facebookJob: FacebookBulkJob | null = null;
  let facebookPauseRequested = false;
  let facebookRowSequence = 0;
  type FacebookCellColumn = "postId" | "url";
  type FacebookCellPosition = { rowKey: number; column: FacebookCellColumn };
  let facebookCellAnchor: FacebookCellPosition | null = null;
  let facebookCellFocus: FacebookCellPosition | null = null;
  let facebookCellDragging = false;

export function bootNotebookApp(): void {
  boot();
}

  function panelQuery<T extends Element = HTMLElement>(selector: string): T {
    const element = state.root.querySelector<T>(selector);
    if (!element) throw new Error(`插件面板缺少必要控件：${selector}`);
    return element;
  }

  function boot() {
    window.addEventListener("message", handleDriveLoaderMessage);
    window.addEventListener("resize", keepPanelInViewport);
    document.addEventListener("DOMContentLoaded", start);
    if (document.readyState !== "loading") start();
  }

  async function start() {
    if (initialized) return;
    initialized = true;
    syncNotebookRoute();
    routeTimerId = window.setInterval(syncNotebookRoute, 700);
    try {
      await initialize();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStage("扩展后台连接失败，请重新加载扩展");
      addLog(`后台连接失败：${message || "未返回具体原因"}。请在扩展管理页确认加载的是 dist 目录，然后重新加载扩展。`, "错误");
      console.error("NotebookLM 助手初始化失败", error);
    }
  }

  async function initialize() {
    const [saved, resources] = await Promise.all([
      extensionClient.getSettings(),
      Promise.resolve(extensionClient.getExtensionResources())
    ]);
    extensionResources = resources;
    const panelSettings = saved.panel;
    state.translateEnabled = panelSettings.aiTranslationEnabled === true;
    state.translationBatchSize = normalizeAiTranslationBatchSize(panelSettings.aiTranslationBatchSize);
    state.autoDeleteImported = panelSettings.autoDeleteImported !== false;
    state.autoRegisterImported = panelSettings.autoRegisterImported === true || panelSettings.facebookAutoRegister === true;
    state.driveBatchSize = normalizeDriveBatchSize(panelSettings.driveBatchSize);
    state.importMode = panelSettings.importMode === "facebook" || panelSettings.facebookImportOpen === true ? "facebook" : "drive";
    state.databaseUrl = String(saved.databaseUrl || "");
    state.minimized = Boolean(panelSettings.minimized);
    state.panelLayout = panelSettings.layout || null;
    syncNotebookRoute();
    if (state.root) {
      panelQuery<HTMLInputElement>("[data-role='database-url']").value = state.databaseUrl;
      state.root.querySelectorAll<HTMLImageElement>("img[data-extension-icon]").forEach((icon) => {
        icon.src = extensionResources.iconUrl || fallbackIconDataUrl();
      });
      restorePanelLayout();
      render();
    }
    await restoreFacebookJob();
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
        state.root = null!;
      }
      return;
    }

    const notebookChanged = Boolean(activeNotebookId && activeNotebookId !== notebookId);
    if (notebookChanged) {
      resetNotebookSession();
    }
    activeNotebookId = notebookId;
    if (!state.root || !state.root.isConnected) createPanel();
    if (notebookChanged) void restoreFacebookJob();
  }

  function resetNotebookSession() {
    pendingDriveDownloads.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("已切换笔记本，当前下载已取消。"));
    });
    pendingDriveDownloads.clear();
    void facebookCoordinator?.cancel();
    facebookCoordinator = null;
    facebookJob = null;
    facebookPauseRequested = true;
    state.facebookActive = false;
    activeDriveUploads.clear();
    if (driveLoaderFrame) driveLoaderFrame.remove();
    driveLoaderFrame = null!;
    driveLoaderReady = null;
    resolveDriveLoaderReady = null;
    state.records = [];
    state.logs = [];
    state.isBusy = false;
    state.driveActivity = { download: "", upload: "" };
    state.stage = "已切换笔记本";
  }

  function createPanel() {
    if (document.getElementById(APP_ID)) return;
    ensureFacebookEditorRows();
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
          <label class="nlm-batch-size nlm-ai-batch-size" title="每次提交给 NotebookLM 翻译的来源数量"><span>每批</span><input type="number" data-role="translation-batch-size" min="${MIN_AI_TRANSLATION_BATCH_SIZE}" max="${MAX_AI_TRANSLATION_BATCH_SIZE}" step="1" inputmode="numeric"><span>个</span></label>
          <button type="button" class="nlm-minimize" data-action="minimize" aria-label="最小化" title="最小化">−</button>
        </div>
      </header>
      <main>
        <section class="nlm-fixed-section">
          <div class="nlm-top-alert" data-role="top-alert" role="alert" aria-live="assertive" hidden></div>
          <label class="nlm-sheet-config">
            <span><b>登记表格</b><small data-role="sheet-save-state">自动缓存</small></span>
            <input type="url" data-role="database-url" placeholder="粘贴含 gid 的 Google 表格链接">
          </label>
          <section class="nlm-import-workspace">
            <nav class="nlm-import-tabs" role="tablist" aria-label="导入方式">
              <button type="button" data-action="switch-import" data-mode="drive" role="tab"><b>Google Drive</b><span>公开音视频链接</span></button>
              <button type="button" data-action="switch-import" data-mode="facebook" role="tab"><b>Facebook</b><span>Colab 批量导入</span></button>
            </nav>
            <section class="nlm-import-pane" data-role="drive-pane" role="tabpanel">
              <textarea data-role="drive-urls" rows="3" spellcheck="false" placeholder="每行粘贴一个公开的 Google Drive 文件链接"></textarea>
              <div class="nlm-import-pane-actions">
                <small>公开链接，无需 Drive 授权</small>
                <label class="nlm-batch-size"><span>每批</span><input type="number" data-role="drive-batch-size" min="1" max="25" step="1" inputmode="numeric"><span>个</span></label>
                <button type="button" data-action="import-drive">开始导入</button>
              </div>
            </section>
            <section class="nlm-import-pane" data-role="facebook-pane" role="tabpanel">
              <div class="nlm-facebook-grid" role="grid" aria-label="Facebook 导入任务表" title="可像表格一样拖选、复制并粘贴两列数据">
                <div class="nlm-facebook-grid-head" role="row"><span></span><b>贴文 ID</b><b>Facebook 链接</b><b>缅文转录</b><b>中文翻译</b></div>
                <div class="nlm-facebook-grid-body" data-role="facebook-grid-body"></div>
              </div>
              <div class="nlm-facebook-table-footer nlm-facebook-table-toolbar">
                <label><input type="checkbox" data-role="facebook-select-all"><span>全选</span></label>
                <span data-role="facebook-row-count">0 条</span>
                <button type="button" data-action="facebook-delete-all" title="立即清空 Facebook 任务表">清空表格</button>
                <button type="button" data-action="facebook-delete-success" title="删除状态为成功的任务行">删除成功</button>
                <button type="button" data-action="facebook-retry-selected" title="重新处理勾选的任务">重试选中</button>
                <button type="button" class="nlm-facebook-start" data-action="import-facebook">开始导入</button>
                <button type="button" class="nlm-facebook-cancel" data-action="cancel-facebook" hidden>暂停</button>
              </div>
            </section>
          </section>
          <section class="nlm-import-options" aria-label="公共导入设置">
            <label><input type="checkbox" data-role="auto-delete-toggle"><span><b>自动移除来源</b><small>完成后释放名额</small></span></label>
            <label><input type="checkbox" data-role="auto-register-toggle"><span><b>自动登记表格</b><small>每批完成后写入</small></span></label>
          </section>
          <div class="nlm-count-card">
            <div class="nlm-count-stat is-total"><b data-role="record-count">0</b><span>总计</span></div>
            <div class="nlm-count-stat is-success"><b data-role="success-count">0</b><span>成功</span></div>
            <div class="nlm-count-stat is-failed"><b data-role="failed-count">0</b><span>失败</span></div>
            <small>仅成功记录可复制和登记</small>
          </div>
          <div class="nlm-result-actions">
            <button type="button" data-action="copy"><span>复制结果</span><small>粘贴到表格</small></button>
            <button type="button" data-action="register"><span>登记表格</span><small>写入 Google Sheets</small></button>
          </div>
          <div class="nlm-extract-actions">
            <button type="button" data-action="extract">提取现有来源</button>
            <button type="button" data-action="clear-records">清空提取记录</button>
            <button type="button" data-action="delete-all-sources">删除已添加的来源</button>
            <span data-role="status">准备就绪</span>
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
    panelQuery<HTMLInputElement>("[data-role='database-url']").value = state.databaseUrl;
    restorePanelLayout();
    bindPanel();
    renderFacebookTable();
    render();
  }

  function bindPanel() {
    panelQuery<HTMLInputElement>("[data-role='translate-toggle']").addEventListener("change", async (event) => {
      state.translateEnabled = (event.currentTarget as HTMLInputElement).checked;
      render();
      await savePanelSettings();
      if (state.translateEnabled && state.records.some((record) => record.transcript && !record.translation && !record.error)) {
        await translateExistingRecords();
      } else {
        setStage(state.translateEnabled ? "AI 翻译已开启" : "AI 翻译已关闭");
      }
    });
    panelQuery<HTMLInputElement>("[data-role='translation-batch-size']").addEventListener("change", async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      state.translationBatchSize = normalizeAiTranslationBatchSize(input.value);
      input.value = String(state.translationBatchSize);
      setStage(`AI 翻译每批处理 ${state.translationBatchSize} 个来源`);
      await savePanelSettings();
    });
    panelQuery<HTMLInputElement>("[data-role='auto-delete-toggle']").addEventListener("change", async (event) => {
      state.autoDeleteImported = (event.currentTarget as HTMLInputElement).checked;
      setStage(state.autoDeleteImported ? "自动移除已开启" : "自动移除已关闭");
      render();
      await savePanelSettings();
    });
    panelQuery<HTMLInputElement>("[data-role='auto-register-toggle']").addEventListener("change", async (event) => {
      state.autoRegisterImported = (event.currentTarget as HTMLInputElement).checked;
      setStage(state.autoRegisterImported ? "每批自动登记已开启" : "自动登记已关闭");
      render();
      await savePanelSettings();
    });
    panelQuery<HTMLInputElement>("[data-role='drive-batch-size']").addEventListener("change", async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      state.driveBatchSize = normalizeDriveBatchSize(input.value);
      input.value = String(state.driveBatchSize);
      setStage(`Drive 每批处理 ${state.driveBatchSize} 个文件`);
      await savePanelSettings();
    });
    const facebookGrid = panelQuery<HTMLElement>("[data-role='facebook-grid-body']");
    facebookGrid.addEventListener("input", handleFacebookGridInput);
    facebookGrid.addEventListener("change", handleFacebookGridChange);
    facebookGrid.addEventListener("paste", handleFacebookGridPaste);
    facebookGrid.addEventListener("mousedown", handleFacebookCellMouseDown);
    facebookGrid.addEventListener("mouseover", handleFacebookCellMouseOver);
    facebookGrid.addEventListener("keydown", handleFacebookGridKeyDown);
    panelQuery<HTMLInputElement>("[data-role='facebook-select-all']").addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      state.facebookRows.forEach((row) => {
        row.selected = checked && isPopulatedFacebookRow(row);
      });
      renderFacebookTable();
    });
    state.root.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
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
      if (button.dataset.action === "switch-import") {
        state.importMode = button.dataset.mode === "facebook" ? "facebook" : "drive";
        render();
        void savePanelSettings();
        return;
      }
      if (button.dataset.action === "facebook-delete-all") {
        void deleteAllFacebookRows();
        return;
      }
      if (button.dataset.action === "facebook-delete-success") {
        void deleteSuccessfulFacebookRows();
        return;
      }
      if (button.dataset.action === "facebook-retry-selected") {
        void retrySelectedFacebookRows();
        return;
      }
      if (button.dataset.action === "show-results") return switchBottomView("results");
      if (button.dataset.action === "show-logs") return switchBottomView("logs");
      if (button.dataset.action === "toggle-bottom") return toggleBottomPanel();
      if (button.dataset.action === "clear-records") {
        if (!state.isBusy) clearRecords();
        return;
      }
      if (button.dataset.action === "cancel-facebook") {
        if (state.facebookActive) {
          facebookPauseRequested = true;
          setStage("将在当前转录或 AI 翻译完成后暂停…");
          addLog("已请求暂停；当前正在翻译时只等待当前一次回答，不再开始后续翻译。转录和翻译状态会分别保存。", "暂停");
          render();
        }
        return;
      }
      if (state.isBusy) return;
      if (button.dataset.action === "extract") extractAllSources();
      if (button.dataset.action === "import-drive") importDriveMedia();
      if (button.dataset.action === "import-facebook") importFacebookMedia();
      if (button.dataset.action === "delete-all-sources") deleteAllSources();
      if (button.dataset.action === "register") registerToSheet();
      if (button.dataset.action === "copy") copyTable();
    });
    bindPanelDrag();
    bindPanelResizePersistence();
    bindDatabaseUrlInput();
  }

  function createFacebookInputRow(postId = "", url = ""): FacebookInputRow {
    facebookRowSequence += 1;
    return {
      key: facebookRowSequence,
      postId,
      url,
      transcriptStatus: postId.trim() || url.trim() ? "待转录" : "待填写",
      transcriptStatusKind: "idle",
      translationStatus: state.translateEnabled ? "等待转录" : "未开启",
      translationStatusKind: "idle",
      selected: false
    };
  }

  function resetFacebookRowProgress(row: FacebookInputRow) {
    row.transcriptStatus = row.postId.trim() || row.url.trim() ? "待转录" : "待填写";
    row.transcriptStatusKind = "idle";
    row.translationStatus = state.translateEnabled ? "等待转录" : "未开启";
    row.translationStatusKind = "idle";
  }

  function ensureFacebookEditorRows(minimum = 1) {
    while (state.facebookRows.length < minimum && state.facebookRows.length < FACEBOOK_MAX_TASKS) {
      state.facebookRows.push(createFacebookInputRow());
    }
    if (shouldAppendFacebookEditorRow(state.facebookRows, FACEBOOK_MAX_TASKS)) {
      state.facebookRows.push(createFacebookInputRow());
    }
  }

  function isPopulatedFacebookRow(row: FacebookInputRow): boolean {
    return isFacebookTableRowPopulated(row);
  }

  function handleFacebookGridInput(event: Event) {
    const input = (event.target as Element).closest<HTMLInputElement>("input[data-facebook-field]");
    if (!input) return;
    const row = state.facebookRows.find((item) => item.key === Number(input.dataset.rowKey));
    if (!row) return;
    if (input.dataset.facebookField === "postId") row.postId = input.value;
    if (input.dataset.facebookField === "url") row.url = input.value;
    resetFacebookRowProgress(row);
  }

  function handleFacebookGridChange(event: Event) {
    const checkbox = (event.target as Element).closest<HTMLInputElement>("input[data-facebook-select]");
    if (checkbox) {
      const row = state.facebookRows.find((item) => item.key === Number(checkbox.dataset.rowKey));
      if (row) row.selected = checkbox.checked;
      renderFacebookTable();
      return;
    }
    if ((event.target as Element).matches("input[data-facebook-field]")) renderFacebookTable();
  }

  function handleFacebookGridPaste(event: ClipboardEvent) {
    const input = (event.target as Element).closest<HTMLInputElement>("input[data-facebook-field]");
    if (!input) return;
    const text = event.clipboardData?.getData("text/plain") || "";
    if (!text.includes("\t") && !/[\r\n]/u.test(text)) return;
    const pasted = parseFacebookClipboardRows(text);
    if (!pasted.length) return;
    event.preventDefault();
    const startIndex = state.facebookRows.findIndex((row) => row.key === Number(input.dataset.rowKey));
    if (startIndex < 0) return;
    const available = FACEBOOK_MAX_TASKS - startIndex;
    pasted.slice(0, available).forEach((cells, offset) => {
      const targetIndex = startIndex + offset;
      while (state.facebookRows.length <= targetIndex) state.facebookRows.push(createFacebookInputRow());
      const row = state.facebookRows[targetIndex];
      if (cells.twoColumns) {
        row.postId = cells.postId;
        row.url = cells.url;
      } else if (input.dataset.facebookField === "url") {
        row.url = cells.url || cells.postId;
      } else {
        row.postId = cells.postId;
      }
      resetFacebookRowProgress(row);
    });
    renderFacebookTable();
    const accepted = Math.min(pasted.length, available);
    setStage(pasted.length > accepted
      ? `已粘贴 ${accepted} 行；另有 ${pasted.length - accepted} 行超过 1000 条上限`
      : `已粘贴 ${accepted} 行 Facebook 数据`);
  }

  function facebookCellPosition(input: HTMLInputElement): FacebookCellPosition | null {
    const column = input.dataset.facebookField;
    if (column !== "postId" && column !== "url") return null;
    const rowKey = Number(input.dataset.rowKey);
    return Number.isFinite(rowKey) ? { rowKey, column } : null;
  }

  function handleFacebookCellMouseDown(event: MouseEvent) {
    const input = (event.target as Element).closest<HTMLInputElement>("input[data-facebook-field]");
    if (!input) return;
    const position = facebookCellPosition(input);
    if (!position) return;
    if (!event.shiftKey || !facebookCellAnchor) facebookCellAnchor = position;
    facebookCellFocus = position;
    facebookCellDragging = true;
    document.addEventListener("mouseup", handleFacebookCellMouseUp, { once: true });
    updateFacebookCellSelectionDom();
  }

  function handleFacebookCellMouseUp() {
    facebookCellDragging = false;
  }

  function handleFacebookCellMouseOver(event: MouseEvent) {
    if (!facebookCellDragging || !(event.buttons & 1)) return;
    const input = (event.target as Element).closest<HTMLInputElement>("input[data-facebook-field]");
    if (!input) return;
    const position = facebookCellPosition(input);
    if (!position) return;
    facebookCellFocus = position;
    updateFacebookCellSelectionDom();
  }

  function getFacebookSelectionBounds() {
    if (!facebookCellAnchor || !facebookCellFocus) return null;
    const anchorRow = state.facebookRows.findIndex((row) => row.key === facebookCellAnchor!.rowKey);
    const focusRow = state.facebookRows.findIndex((row) => row.key === facebookCellFocus!.rowKey);
    if (anchorRow < 0 || focusRow < 0) return null;
    const columns: FacebookCellColumn[] = ["postId", "url"];
    const anchorColumn = columns.indexOf(facebookCellAnchor.column);
    const focusColumn = columns.indexOf(facebookCellFocus.column);
    return {
      rowStart: Math.min(anchorRow, focusRow),
      rowEnd: Math.max(anchorRow, focusRow),
      columnStart: Math.min(anchorColumn, focusColumn),
      columnEnd: Math.max(anchorColumn, focusColumn),
      columns
    };
  }

  function updateFacebookCellSelectionDom() {
    const bounds = getFacebookSelectionBounds();
    state.root?.querySelectorAll<HTMLInputElement>("input[data-facebook-field]").forEach((input) => {
      const rowIndex = state.facebookRows.findIndex((row) => row.key === Number(input.dataset.rowKey));
      const columnIndex = bounds?.columns.indexOf(input.dataset.facebookField as FacebookCellColumn) ?? -1;
      input.classList.toggle("is-cell-selected", Boolean(bounds
        && rowIndex >= bounds.rowStart && rowIndex <= bounds.rowEnd
        && columnIndex >= bounds.columnStart && columnIndex <= bounds.columnEnd));
    });
  }

  async function handleFacebookGridKeyDown(event: KeyboardEvent) {
    const bounds = getFacebookSelectionBounds();
    if (!bounds) return;
    const cellCount = (bounds.rowEnd - bounds.rowStart + 1) * (bounds.columnEnd - bounds.columnStart + 1);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && cellCount > 1) {
      event.preventDefault();
      const text = state.facebookRows.slice(bounds.rowStart, bounds.rowEnd + 1).map((row) => (
        bounds.columns.slice(bounds.columnStart, bounds.columnEnd + 1)
          .map((column) => row[column])
          .join("\t")
      )).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        setStage(`已复制 ${cellCount} 个 Facebook 表格单元格`);
      } catch {
        setStage("复制失败，请允许网页访问剪贴板后重试");
      }
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && cellCount > 1 && !state.isBusy) {
      event.preventDefault();
      state.facebookRows.slice(bounds.rowStart, bounds.rowEnd + 1).forEach((row) => {
        bounds.columns.slice(bounds.columnStart, bounds.columnEnd + 1).forEach((column) => { row[column] = ""; });
        resetFacebookRowProgress(row);
      });
      renderFacebookTable();
      setStage(`已清空 ${cellCount} 个 Facebook 表格单元格`);
    }
  }

  async function removeFacebookRows(rows: FacebookInputRow[], label: string) {
    if (state.isBusy) return setStage("任务运行期间不能修改 Facebook 队列");
    const targetRows = rows.filter(isPopulatedFacebookRow);
    if (!targetRows.length) return false;
    if (facebookJob?.activeSourceIds.length) {
      setStage("队列仍有中断批次来源，请先继续队列完成清理后再删除任务");
      return false;
    }
    if (facebookJob) {
      const selectedTaskIds = new Set(targetRows.map((row) => row.persistedTaskId).filter(Boolean) as string[]);
      const selectedKeys = new Set(targetRows.map((row) => `${stripSourceSuffix(row.postId)}\n${row.url.trim()}`));
      facebookJob.tasks.forEach((task) => {
        if (selectedKeys.has(`${stripSourceSuffix(task.postId)}\n${task.url.trim()}`)) selectedTaskIds.add(task.taskId);
      });
      if (selectedTaskIds.size) {
        const updatedJob = removeFacebookJobTasks(facebookJob, selectedTaskIds);
        try {
          await extensionClient.saveFacebookJob(updatedJob);
          facebookJob = updatedJob;
        } catch (error) {
          setStage("删除失败：无法更新 Facebook 队列缓存，请重试");
          addLog(error instanceof Error ? error.message : String(error), "队列缓存");
          return false;
        }
      }
    }
    const targetKeys = new Set(targetRows.map((row) => row.key));
    state.facebookRows = state.facebookRows.filter((row) => !targetKeys.has(row.key));
    ensureFacebookEditorRows();
    facebookCellAnchor = null;
    facebookCellFocus = null;
    renderFacebookTable();
    setStage(`${label} ${targetRows.length} 行，并同步更新队列缓存`);
    return true;
  }

  async function deleteAllFacebookRows() {
    const rows = state.facebookRows.filter(isPopulatedFacebookRow);
    if (!rows.length) return setStage("Facebook 任务表已经为空");
    await removeFacebookRows(rows, "已清空表格，共移除");
  }

  async function deleteSuccessfulFacebookRows() {
    const translationRequired = facebookJob?.translate ?? state.translateEnabled;
    const rows = state.facebookRows.filter((row) => isPopulatedFacebookRow(row) &&
      row.transcriptStatusKind === "success" &&
      (!translationRequired || row.translationStatusKind === "success"));
    if (!rows.length) return setStage("当前没有可删除的成功任务");
    await removeFacebookRows(rows, "已删除成功任务");
  }

  async function retrySelectedFacebookRows() {
    if (state.isBusy) return setStage("当前任务尚未结束，请稍后再重试");
    if (facebookJob?.activeSourceIds.length) {
      return setStage("队列仍有中断批次来源，请先继续队列完成清理后再重试");
    }
    const rows = state.facebookRows.filter((row) => row.selected && isPopulatedFacebookRow(row));
    if (!rows.length) return setStage("请先勾选要重试的 Facebook 任务");
    rows.forEach((row) => {
      row.transcriptStatus = "等待重试";
      row.transcriptStatusKind = "idle";
      row.translationStatus = state.translateEnabled ? "等待转录" : "未开启";
      row.translationStatusKind = "idle";
      row.selected = false;
    });
    renderFacebookTable();
    addLog(`准备重新处理选中的 ${rows.length} 条 Facebook 任务。`, "重新处理");
    await importFacebookMedia(rows);
  }

  function renderFacebookTable() {
    if (!state.root) return;
    ensureFacebookEditorRows();
    const parsed = parseFacebookTableRows(state.facebookRows, FACEBOOK_MAX_TASKS);
    const issues = new Map(parsed.issues.map((issue) => [issue.index, issue.message]));
    const body = panelQuery<HTMLElement>("[data-role='facebook-grid-body']");
    body.innerHTML = state.facebookRows.map((row, index) => {
      const issue = issues.get(index);
      const transcriptStatus = issue || row.transcriptStatus;
      const transcriptKind = issue ? "error" : row.transcriptStatusKind;
      return `<div class="nlm-facebook-grid-row ${row.selected ? "is-selected" : ""} ${issue ? "has-error" : ""}" role="row" data-row-key="${row.key}">
        <label><input type="checkbox" data-facebook-select data-row-key="${row.key}" ${row.selected ? "checked" : ""} ${state.isBusy ? "disabled" : ""} aria-label="选择第 ${index + 1} 行"></label>
        <input type="text" data-facebook-field="postId" data-row-key="${row.key}" value="${escapeHtml(row.postId)}" placeholder="贴文 ID" spellcheck="false" ${state.isBusy ? "disabled" : ""}>
        <input type="url" data-facebook-field="url" data-row-key="${row.key}" value="${escapeHtml(row.url)}" placeholder="https://facebook.com/..." spellcheck="false" ${state.isBusy ? "disabled" : ""}>
        <span class="nlm-facebook-row-status is-${transcriptKind}" data-facebook-status="transcript" title="${escapeHtml(transcriptStatus)}">${escapeHtml(transcriptStatus)}</span>
        <span class="nlm-facebook-row-status is-${row.translationStatusKind}" data-facebook-status="translation" title="${escapeHtml(row.translationStatus)}">${escapeHtml(row.translationStatus)}</span>
      </div>`;
    }).join("");
    const populatedRows = state.facebookRows.filter(isPopulatedFacebookRow);
    const populated = populatedRows.length;
    panelQuery("[data-role='facebook-row-count']").textContent = `${populated} 条`;
    const selectAll = panelQuery<HTMLInputElement>("[data-role='facebook-select-all']");
    const selectedPopulated = populatedRows.filter((row) => row.selected);
    selectAll.checked = Boolean(populatedRows.length && selectedPopulated.length === populatedRows.length);
    selectAll.indeterminate = selectedPopulated.length > 0 && !selectAll.checked;
    selectAll.disabled = state.isBusy || !populatedRows.length;
    panelQuery<HTMLButtonElement>("[data-action='facebook-delete-all']").disabled = state.isBusy || !populatedRows.length;
    const translationRequired = facebookJob?.translate ?? state.translateEnabled;
    panelQuery<HTMLButtonElement>("[data-action='facebook-delete-success']").disabled = state.isBusy || !populatedRows.some((row) =>
      row.transcriptStatusKind === "success" && (!translationRequired || row.translationStatusKind === "success"));
    panelQuery<HTMLButtonElement>("[data-action='facebook-retry-selected']").disabled = state.isBusy || !selectedPopulated.length;
    updateFacebookCellSelectionDom();
  }

  function setFacebookTaskTranscriptionStatuses(
    tasks: Array<{ postId: string; url: string }>,
    status: string,
    statusKind: FacebookStatusKind,
    shouldRender = true
  ) {
    const taskKeys = new Set(tasks.map((task) => `${stripSourceSuffix(task.postId)}\n${task.url}`));
    const changedRows: FacebookInputRow[] = [];
    state.facebookRows.forEach((row) => {
      if (taskKeys.has(`${stripSourceSuffix(row.postId)}\n${row.url}`)) {
        row.transcriptStatus = status;
        row.transcriptStatusKind = statusKind;
        changedRows.push(row);
      }
    });
    if (shouldRender) renderFacebookTable();
    else changedRows.forEach((row) => updateFacebookRowStatusDom(row, "transcript"));
  }

  function setFacebookTaskTranslationStatuses(
    tasks: Array<{ postId: string; url: string }>,
    status: string,
    statusKind: FacebookStatusKind,
    shouldRender = true
  ) {
    const taskKeys = new Set(tasks.map((task) => `${stripSourceSuffix(task.postId)}\n${task.url}`));
    const changedRows: FacebookInputRow[] = [];
    state.facebookRows.forEach((row) => {
      if (taskKeys.has(`${stripSourceSuffix(row.postId)}\n${row.url}`)) {
        row.translationStatus = status;
        row.translationStatusKind = statusKind;
        changedRows.push(row);
      }
    });
    if (shouldRender) renderFacebookTable();
    else changedRows.forEach((row) => updateFacebookRowStatusDom(row, "translation"));
  }

  function updateFacebookRowStatusDom(row: FacebookInputRow, phase: "transcript" | "translation") {
    const status = state.root?.querySelector<HTMLElement>(`.nlm-facebook-grid-row[data-row-key="${row.key}"] [data-facebook-status="${phase}"]`);
    if (!status) return;
    const value = phase === "transcript" ? row.transcriptStatus : row.translationStatus;
    const kind = phase === "transcript" ? row.transcriptStatusKind : row.translationStatusKind;
    status.className = `nlm-facebook-row-status is-${kind}`;
    status.textContent = value;
    status.title = value;
  }

  async function importFacebookMedia(inputRows: FacebookInputRow[] = state.facebookRows) {
    const parsed = parseFacebookTableRows(inputRows, FACEBOOK_MAX_TASKS);
    renderFacebookTable();
    if (!parsed.tasks.length) {
      setStage(parsed.errors[0] || "请填写有效的 Facebook 公开视频任务");
      return;
    }
    if (parsed.issues.length) {
      setStage(`Facebook 表格有 ${parsed.issues.length} 行需要修正`);
      parsed.errors.slice(0, 20).forEach((message) => addLog(message, "输入校验"));
      return;
    }

    const databaseUrl = panelQuery<HTMLInputElement>("[data-role='database-url']").value.trim();
    let sourceSummary;
    try {
      sourceSummary = await getNotebookSourceSummary();
      if (state.autoRegisterImported && !(await validateAutomaticRegistration(databaseUrl))) return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStage("无法检查导入条件，请刷新 NotebookLM 后重试");
      addLog(message, "预检查失败");
      return;
    }
    const existingFingerprint = facebookJob ? facebookTaskFingerprint(facebookJob.tasks) : "";
    const inputFingerprint = facebookTaskFingerprint(parsed.tasks);
    const canResume = Boolean(facebookJob && facebookJob.status !== "completed" && existingFingerprint === inputFingerprint);
    if (canResume && facebookJob!.activeSourceIds.length) {
      const recovered = await recoverInterruptedFacebookBatch(facebookJob!, sourceSummary);
      if (!recovered) return;
      sourceSummary = recovered;
    }

    const currentCapacity = retainedSourceCapacity(sourceSummary.totalSources);
    if (!state.autoDeleteImported) {
      const required = canResume ? facebookJob!.tasks.length - facebookJob!.nextIndex : parsed.tasks.length;
      if (required > currentCapacity) {
        setStage(`自动移除已关闭：当前最多还能导入 ${currentCapacity} 个来源`);
        addLog(`当前笔记本已有 ${sourceSummary.totalSources}/${NOTEBOOK_SOURCE_LIMIT} 个来源；待导入 ${required} 个，超出剩余名额 ${currentCapacity}。请减少输入或开启自动移除。`, "来源上限");
        return;
      }
    }

    if (!canResume) {
      if (facebookJob && facebookJob.status !== "completed" && existingFingerprint !== inputFingerprint) {
        const replace = window.confirm("当前笔记本还有未完成的 Facebook 队列。是否用新输入替换原队列？\n\n已完成并保存的转录记录会保留在结果中。");
        if (!replace) return setStage("已保留原 Facebook 队列");
      }
      facebookJob = createFacebookJob(activeNotebookId, parsed.tasks, {
        autoDelete: state.autoDeleteImported,
        translate: state.translateEnabled,
        autoRegister: state.autoRegisterImported
      });
      facebookJob.records = [];
    } else {
      facebookJob!.autoDelete = state.autoDeleteImported;
      facebookJob!.translate = state.translateEnabled;
      facebookJob!.autoRegister = state.autoRegisterImported;
    }
    const job = facebookJob;
    if (!job) throw new Error("无法创建 Facebook 批量任务。");
    linkFacebookRowsToJobTasks(job);

    state.isBusy = true;
    state.facebookActive = true;
    facebookPauseRequested = false;
    if (!canResume) state.logs = [];
    state.bottomOpen = true;
    state.bottomView = "logs";
    parsed.errors.forEach((message) => addLog(message, "输入提示"));
    addLog(`${canResume ? "继续" : "准备"}处理 ${job.tasks.length} 个 Facebook 公开视频；从第 ${job.nextIndex + 1} 条开始，每批最多 ${FACEBOOK_BATCH_SIZE} 条。`, "Facebook 队列");
    job.status = "running";
    job.lastError = undefined;
    if (canResume) await saveFacebookCheckpoint();
    else await extensionClient.saveFacebookJob(job);
    render();

    let activeBatchRecords: TranscriptRecord[] = [];
    try {
      let queueBatchSequence = 0;
      if (canResume) {
        const resumableRecords = state.records.filter((record) => record.sourceId && record.transcript &&
          !record.error && !record.sourceDeleted);
        const pendingTranslations = resumableRecords.filter((record) => !record.translation);
        if (job.translate && resumableRecords.length) {
          if (pendingTranslations.length) {
            addLog(`先继续上次暂停时保留的 ${pendingTranslations.length} 个中文翻译，再导入新来源。`, "恢复翻译");
          }
          const shouldStop = await translateFacebookRecords(job, resumableRecords, databaseUrl, "恢复翻译");
          if (shouldStop) facebookPauseRequested = true;
        } else if (!job.translate && resumableRecords.length) {
          await finalizeFacebookRecords(job, resumableRecords, databaseUrl, "恢复转录");
        }
      }
      while (job.nextIndex < job.tasks.length && !facebookPauseRequested) {
        activeBatchRecords = [];
        const summary = await getNotebookSourceSummary();
        const batch = nextFacebookBatch(job, summary.totalSources);
        if (!batch.length) {
          throw new Error(`当前笔记本已有 ${summary.totalSources}/${NOTEBOOK_SOURCE_LIMIT} 个来源，没有可用来源名额。请清理来源后继续。`);
        }
        queueBatchSequence += 1;
        const batchLabel = `${queueBatchSequence}（${job.nextIndex + 1}-${job.nextIndex + batch.length}/${job.tasks.length}）`;
        setStage(`Facebook 批次 ${batchLabel}：处理 ${batch.length} 条…`);
        addLog(`批次 ${batchLabel} 开始；当前来源 ${summary.totalSources}/${NOTEBOOK_SOURCE_LIMIT}。`, "Facebook 批次");
        setFacebookTaskTranscriptionStatuses(batch, "处理中", "working");
        setFacebookTaskTranslationStatuses(batch, job.translate ? "等待转录" : "未开启", "idle");

        job.activeBatchStart = job.nextIndex;
        job.activeSourceIds = [];
        await extensionClient.updateFacebookJobActiveSources(job.notebookId, job.activeBatchStart, []);
        facebookCoordinator = new FacebookImportCoordinator({
          onStage: setStage,
          onLog: addLog,
          onTaskStatus: (taskId, taskStatus, message) => {
            const task = batch.find((item) => item.taskId === taskId);
            if (!task) return;
            const labels: Record<string, string> = {
              downloaded: "下载完成",
              uploading: "正在上传",
              processing: "等待转录",
              completed: "导入完成"
            };
            setFacebookTaskTranscriptionStatuses(
              [task],
              taskStatus === "failed" ? `失败：${message || "任务失败"}` : labels[taskStatus] || "处理中",
              taskStatus === "failed" ? "error" : taskStatus === "completed" ? "success" : "working",
              false
            );
          },
          onSourcePrepared: async (sourceId) => {
            if (!job.activeSourceIds.includes(sourceId)) job.activeSourceIds.push(sourceId);
            await extensionClient.updateFacebookJobActiveSources(job.notebookId, job.activeBatchStart, job.activeSourceIds);
          }
        });
        const records = await facebookCoordinator.start(batch, false);
        facebookCoordinator = null;
        const added = mergeRecords(records);
        const batchRecords = resolveMergedRecords(records);
        activeBatchRecords = batchRecords;
        const failed = batchRecords.filter((record) => record.error || !record.transcript).length;
        batch.forEach((task) => {
          const record = batchRecords.find((item) => stripSourceSuffix(item.sourceName) === stripSourceSuffix(task.postId));
          const failedTask = Boolean(record?.error || !record?.transcript);
          setFacebookTaskTranscriptionStatuses(
            [task],
            failedTask ? `失败：${record?.error || "未返回转录"}` : "已转录",
            failedTask ? "error" : "success",
            false
          );
          setFacebookTaskTranslationStatuses(
            [task],
            failedTask ? (job.translate ? "已跳过" : "未开启") : (job.translate ? "待翻译" : "未开启"),
            failedTask && job.translate ? "error" : "idle",
            false
          );
        });
        renderFacebookTable();

        // Transcription is the durable import checkpoint. Translation is resumed independently.
        job.nextIndex += batch.length;
        job.activeBatchStart = job.nextIndex;
        job.activeSourceIds = [];
        job.records = getFacebookJobRecords(job);
        job.status = job.nextIndex >= job.tasks.length && !job.translate ? "completed" : "running";
        job.lastError = undefined;
        await saveFacebookCheckpoint(batchRecords);
        addLog(`批次 ${batchLabel} 转录检查点已保存：成功 ${added}，失败 ${failed}；导入进度 ${job.nextIndex}/${job.tasks.length}。`, failed ? "转录完成（有失败）" : "转录完成");

        const shouldStop = await translateFacebookRecords(job, batchRecords, databaseUrl, batchLabel);
        if (shouldStop) facebookPauseRequested = true;
        render();
      }

      const pendingTranslations = job.translate && state.records.some((record) => record.sourceId && record.transcript &&
        !record.error && !record.translation && !record.sourceDeleted);
      if (facebookPauseRequested || job.nextIndex < job.tasks.length || pendingTranslations) {
        job.status = "paused";
        await saveFacebookCheckpoint();
        setStage(`Facebook 队列已暂停：已转录 ${job.nextIndex}/${job.tasks.length}`);
      } else {
        job.status = "completed";
        await saveFacebookCheckpoint();
        const failures = job.records.filter((record) => record.error || !record.transcript).length;
        setStage(`Facebook 队列完成：${job.nextIndex}/${job.tasks.length}，失败 ${failures}`);
        addLog(`Facebook 队列全部完成：共 ${job.tasks.length} 条。`, failures ? "完成（有失败）" : "完成");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const userPaused = error instanceof AiTranslationPauseError;
      await facebookCoordinator?.cancel();
      if (facebookJob) {
        if (facebookJob.autoDelete && facebookJob.activeSourceIds.length) {
          await cleanupInterruptedFacebookSources(facebookJob);
        }
        facebookJob.status = "paused";
        facebookJob.lastError = userPaused ? undefined : message;
        facebookJob.records = getFacebookJobRecords(facebookJob);
        await saveFacebookCheckpoint(activeBatchRecords);
        syncFacebookRowsFromRecords(facebookJob);
      }
      setStage(userPaused
        ? `Facebook 队列已暂停：已转录 ${facebookJob?.nextIndex || 0}/${facebookJob?.tasks.length || 0}`
        : `${message} 已保存进度，可处理问题后继续。`);
      addLog(`${message}；检查点停在 ${facebookJob?.nextIndex || 0}/${facebookJob?.tasks.length || 0}。`, "队列暂停");
    } finally {
      facebookCoordinator = null;
      state.facebookActive = false;
      state.isBusy = false;
      facebookPauseRequested = false;
      render();
    }
  }

  async function restoreFacebookJob() {
    const notebookId = activeNotebookId;
    if (!notebookId) return;
    try {
      const saved = await extensionClient.loadFacebookJob(notebookId);
      if (activeNotebookId !== notebookId) return;
      if (!saved) {
        facebookJob = null;
        return;
      }
      facebookJob = saved;
      if (facebookJob.status === "running") {
        facebookJob.status = "paused";
        facebookJob.lastError = "页面或浏览器在批次运行期间中断。";
        await saveFacebookCheckpoint();
      }
      state.records = Array.isArray(facebookJob.records) ? facebookJob.records.slice() : [];
      if (state.root) {
        state.facebookRows = facebookJob.tasks.map((task) => {
          const row = createFacebookInputRow(task.postId, task.url);
          row.persistedTaskId = task.taskId;
          return row;
        });
        syncFacebookRowsFromRecords(facebookJob);
      }
      state.stage = facebookJob.status === "completed"
        ? `已恢复已完成队列：${facebookJob.nextIndex}/${facebookJob.tasks.length}`
        : `发现未完成队列：${facebookJob.nextIndex}/${facebookJob.tasks.length}，可继续`;
      render();
    } catch (error) {
      addLog(`恢复 Facebook 队列失败：${error instanceof Error ? error.message : String(error)}`, "检查点");
    }
  }

  async function saveFacebookCheckpoint(records: TranscriptRecord[] = []) {
    if (!facebookJob) return;
    facebookJob.updatedAt = Date.now();
    await extensionClient.updateFacebookJobProgress({
      notebookId: facebookJob.notebookId,
      status: facebookJob.status,
      nextIndex: facebookJob.nextIndex,
      activeBatchStart: facebookJob.activeBatchStart,
      activeSourceIds: facebookJob.activeSourceIds.slice(),
      autoDelete: facebookJob.autoDelete,
      translate: facebookJob.translate,
      autoRegister: facebookJob.autoRegister,
      lastError: facebookJob.lastError,
      records: records.map((record) => ({ ...record }))
    });
  }

  function linkFacebookRowsToJobTasks(job: FacebookBulkJob) {
    const tasksByKey = new Map(job.tasks.map((task) => [
      `${stripSourceSuffix(task.postId)}\n${task.url.trim()}`,
      task.taskId
    ]));
    state.facebookRows.forEach((row) => {
      delete row.persistedTaskId;
      row.persistedTaskId = tasksByKey.get(`${stripSourceSuffix(row.postId)}\n${row.url.trim()}`);
    });
  }

  async function recoverInterruptedFacebookBatch(
    job: FacebookBulkJob,
    sourceSummary: { totalSources: number; sourceIds: string[] }
  ): Promise<{ totalSources: number; sourceIds: string[] } | null> {
    const existingIds = new Set(sourceSummary.sourceIds);
    job.activeSourceIds = job.activeSourceIds.filter((sourceId) => existingIds.has(sourceId));
    if (!job.activeSourceIds.length) {
      job.activeBatchStart = job.nextIndex;
      await saveFacebookCheckpoint();
      return sourceSummary;
    }
    if (!state.autoDeleteImported) {
      setStage(`发现上次中断批次遗留 ${job.activeSourceIds.length} 个来源`);
      addLog("自动移除已关闭，无法安全判断遗留来源是否完成。请开启自动移除后继续，或手动清理这些来源并刷新页面。", "断点恢复");
      return null;
    }

    setStage(`正在清理上次中断批次的 ${job.activeSourceIds.length} 个来源…`);
    addLog(`检查点位于第 ${job.activeBatchStart + 1} 条；正在精确清理未提交批次后重试。`, "断点恢复");
    await cleanupInterruptedFacebookSources(job);
    if (job.activeSourceIds.length) {
      setStage(`中断批次仍有 ${job.activeSourceIds.length} 个来源无法移除`);
      addLog("请手动清理失败来源后刷新页面再继续，避免产生重复来源。", "断点恢复失败");
      return null;
    }
    await saveFacebookCheckpoint();
    addLog("上次中断批次已清理，将从该批次起点重新执行。", "断点恢复");
    return getNotebookSourceSummary();
  }

  async function cleanupInterruptedFacebookSources(job: FacebookBulkJob): Promise<void> {
    const candidateIds = Array.from(new Set(job.activeSourceIds.filter(Boolean)));
    if (!candidateIds.length) return;
    try {
      const result = await deleteNotebookSources(candidateIds);
      markSourcesDeleted(result.deleted);
      const refreshed = await getNotebookSourceSummary();
      const stillExisting = new Set(refreshed.sourceIds);
      job.activeSourceIds = candidateIds.filter((sourceId) => stillExisting.has(sourceId));
    } catch (cleanupError) {
      addLog(`中断批次清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, "断点恢复失败");
    }
    await extensionClient.updateFacebookJobActiveSources(job.notebookId, job.activeBatchStart, job.activeSourceIds);
  }

  async function getNotebookSourceSummary(): Promise<{ totalSources: number; sourceIds: string[] }> {
    const summary = await callPageApi("get-source-summary", {}, API_TIMEOUT_MS);
    return {
      totalSources: Math.max(0, Number(summary?.totalSources) || 0),
      sourceIds: Array.isArray(summary?.sourceIds) ? summary.sourceIds.filter(Boolean) : []
    };
  }

  function resolveMergedRecords(records: TranscriptRecord[]): TranscriptRecord[] {
    return records.map((record) => {
      if (record.sourceId) {
        const matched = state.records.find((item) => item.sourceId === record.sourceId);
        if (matched) return matched;
      }
      const normalizedName = stripSourceSuffix(record.sourceName);
      return state.records.find((item) => item.sourceName === normalizedName && item.error === record.error) || record;
    });
  }

  function getFacebookJobRecords(job: FacebookBulkJob): TranscriptRecord[] {
    const sourceNames = new Set(job.tasks.map((task) => stripSourceSuffix(task.postId)));
    return state.records.filter((record) => sourceNames.has(record.sourceName)).map((record) => ({ ...record }));
  }

  function facebookTasksForRecords(job: FacebookBulkJob, records: TranscriptRecord[]) {
    const names = new Set(records.map((record) => stripSourceSuffix(record.sourceOriginalName || record.sourceName)));
    return job.tasks.filter((task) => names.has(stripSourceSuffix(task.postId)));
  }

  function syncFacebookRowsFromRecords(job: FacebookBulkJob) {
    const recordsByName = new Map(state.records.map((record) => [
      stripSourceSuffix(record.sourceOriginalName || record.sourceName),
      record
    ]));
    job.tasks.forEach((task, index) => {
      const row = state.facebookRows.find((item) => item.persistedTaskId === task.taskId) ||
        state.facebookRows.find((item) => stripSourceSuffix(item.postId) === stripSourceSuffix(task.postId));
      if (!row) return;
      const record = recordsByName.get(stripSourceSuffix(task.postId));
      if (record?.error || (index < job.nextIndex && !record?.transcript)) {
        row.transcriptStatus = `失败：${record?.error || "未返回转录"}`;
        row.transcriptStatusKind = "error";
        row.translationStatus = job.translate ? "已跳过" : "未开启";
        row.translationStatusKind = job.translate ? "error" : "idle";
        return;
      }
      if (record?.transcript) {
        row.transcriptStatus = "已转录";
        row.transcriptStatusKind = "success";
        if (!job.translate) {
          row.translationStatus = "未开启";
          row.translationStatusKind = "idle";
        } else if (record.translation) {
          row.translationStatus = "已翻译";
          row.translationStatusKind = "success";
        } else if (record.translationError) {
          row.translationStatus = `失败：${record.translationError}`;
          row.translationStatusKind = "error";
        } else {
          row.translationStatus = "待翻译";
          row.translationStatusKind = "idle";
        }
        return;
      }
      row.transcriptStatus = index < job.nextIndex ? "转录失败" : "待转录";
      row.transcriptStatusKind = index < job.nextIndex ? "error" : "idle";
      row.translationStatus = job.translate ? "等待转录" : "未开启";
      row.translationStatusKind = "idle";
    });
    renderFacebookTable();
  }

  async function finalizeFacebookRecords(
    job: FacebookBulkJob,
    records: TranscriptRecord[],
    databaseUrl: string,
    batchLabel: string
  ) {
    const completed = records.filter((record) => record.transcript && !record.error &&
      (!job.translate || Boolean(record.translation)));
    if (job.autoRegister) {
      const unregistered = completed.filter((record) => !record.registered);
      if (unregistered.length) await autoRegisterImportBatch(unregistered, databaseUrl, `Facebook ${batchLabel}`);
    }
    if (job.autoDelete) {
      const deletable = records.filter((record) => !record.sourceDeleted);
      const sourceIds = completedSourceIdsForCleanup(deletable, job.translate);
      if (sourceIds.length) await deleteImportedBatch(sourceIds, batchLabel);
      const retained = records.filter((record) => record.sourceId && record.transcript && !record.error &&
        !record.sourceDeleted && (!job.translate || !record.translation)).length;
      if (retained > 0) {
        addLog(`批次 ${batchLabel} 保留 ${retained} 个尚未完成中文翻译的来源。`, "来源保留");
      }
    }
    job.records = getFacebookJobRecords(job);
    await saveFacebookCheckpoint(records);
    syncFacebookRowsFromRecords(job);
  }

  async function translateFacebookRecords(
    job: FacebookBulkJob,
    records: TranscriptRecord[],
    databaseUrl: string,
    batchLabel: string
  ) {
    const pending = records.filter((record) => record.sourceId && record.transcript && !record.error &&
      !record.translation && !record.sourceDeleted);
    if (!job.translate || !pending.length) {
      await finalizeFacebookRecords(job, records, databaseUrl, batchLabel);
      return false;
    }
    const summary = await translateRecords({
      sourceIds: pending.map((record) => record.sourceId),
      shouldPause: () => facebookPauseRequested,
      onBatchStart: (translationBatch) => {
        setFacebookTaskTranslationStatuses(facebookTasksForRecords(job, translationBatch), "翻译中", "working");
      },
      onBatchComplete: async (translationBatch) => {
        job.records = getFacebookJobRecords(job);
        syncFacebookRowsFromRecords(job);
        await saveFacebookCheckpoint(translationBatch);
      }
    });
    await finalizeFacebookRecords(job, records, databaseUrl, batchLabel);
    const incomplete = pending.some((record) => !record.translation);
    if (incomplete && !summary.paused) {
      addLog(`${batchLabel} 仍有 ${pending.filter((record) => !record.translation).length} 个来源未完成中文翻译，队列已暂停以保留来源。`, "翻译待处理");
    }
    return summary.paused || incomplete;
  }

  async function autoRegisterImportBatch(records: TranscriptRecord[], databaseUrl: string, batchLabel: string) {
    const available = records.filter((record) => record.transcript && !record.error);
    if (!available.length) {
      addLog(`${batchLabel} 没有成功转录，已跳过自动登记。`, "自动登记");
      return;
    }
    const sheetRecords = toSheetRecords(available, sourceNameToPostId);
    const batches = chunkSheetRegistrationRecords(sheetRecords, databaseUrl);
    const statusCounts = Object.create(null);
    let totalSuccess = 0;
    let totalFailed = 0;
    let batchStart = 0;
    for (let index = 0; index < batches.length; index += 1) {
      const current = batches[index];
      const currentLabel = `${batchLabel}.${index + 1}/${batches.length}`;
      const attempts = await submitSheetBatchAdaptive(databaseUrl, current, batchStart, currentLabel);
      attempts.forEach((attempt) => {
        if (attempt.error) {
          totalFailed += attempt.records.length;
          addStatusCount(statusCounts, "request_failed", attempt.records.length);
          addLog(formatSheetRequestError(attempt.error, attempt.records), "自动登记失败");
          return;
        }
        const analysis = analyzeBatchResponse(attempt.result as any, attempt.records, {
          batchStart: attempt.batchStart,
          batchLabel: attempt.batchLabel
        });
        mergeStatusCounts(statusCounts, analysis.statusCounts);
        totalSuccess += analysis.success;
        totalFailed += analysis.failed;
        analysis.failureLogs.forEach((entry) => addLog(entry.message, entry.title));
      });
      batchStart += current.length;
    }
    addLog(formatStatusCounts(statusCounts), "自动登记 status_counts");
    if (!totalFailed) {
      available.forEach((record) => {
        record.registered = true;
        record.registrationError = undefined;
      });
    } else {
      available.forEach((record) => { record.registrationError = `批次自动登记存在 ${totalFailed} 条失败，可稍后手动登记。`; });
    }
    addLog(`${batchLabel} 自动登记：成功 ${totalSuccess}，失败 ${totalFailed}。`, totalFailed ? "自动登记失败" : "自动登记");
  }

  function handleDriveLoaderMessage(event) {
    if (!driveLoaderFrame || event.source !== driveLoaderFrame.contentWindow ||
      event.origin !== extensionResources.extensionOrigin) return;
    const { source, target, type, token, requestId, payload } = event.data || {};
    if (source !== APP_ID || target !== "content" || token !== DRIVE_BRIDGE_TOKEN) return;
    if (type === "drive-loader-ready") {
      resolveDriveLoaderReady?.();
      return;
    }
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
    const input = panelQuery<HTMLTextAreaElement>("[data-role='drive-urls']");
    const urls = parseDriveUrls(input.value);
    if (!urls.length) {
      setStage("请粘贴有效的 Drive 文件链接");
      return;
    }

    const databaseUrl = panelQuery<HTMLInputElement>("[data-role='database-url']").value.trim();
    let sourceSummary;
    try {
      sourceSummary = await getNotebookSourceSummary();
      if (state.autoRegisterImported && !(await validateAutomaticRegistration(databaseUrl))) return;
    } catch (error) {
      setStage("无法检查 Drive 导入条件");
      addLog(error instanceof Error ? error.message : String(error), "预检查失败");
      return;
    }
    if (!state.autoDeleteImported) {
      const capacity = retainedSourceCapacity(sourceSummary.totalSources);
      if (urls.length > capacity) {
        setStage(`自动移除已关闭：当前最多还能导入 ${capacity} 个来源`);
        addLog(`当前笔记本已有 ${sourceSummary.totalSources}/${NOTEBOOK_SOURCE_LIMIT} 个来源；待导入 ${urls.length} 个，超过剩余名额 ${capacity}。`, "来源上限");
        return;
      }
    }

    const batchInput = panelQuery<HTMLInputElement>("[data-role='drive-batch-size']");
    state.driveBatchSize = normalizeDriveBatchSize(batchInput.value);
    batchInput.value = String(state.driveBatchSize);
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

        const extractedIds = new Set<string>(extractionSummary.extractedSourceIds as string[]);
        const batchRecords = state.records.filter((record) => extractedIds.has(record.sourceId));
        if (state.autoRegisterImported) {
          await autoRegisterImportBatch(batchRecords, databaseUrl, `Drive ${batchLabel}`);
        }

        const deletionCandidates = completedSourceIdsForCleanup(batchRecords, state.translateEnabled);
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

  async function validateAutomaticRegistration(databaseUrl: string): Promise<boolean> {
    const settings = await extensionClient.getSettings();
    if (!validDeploymentUrl(settings.deploymentUrl)) {
      setStage("自动登记未启动：请先在插件图标中填写完整部署脚本链接");
      addLog("Apps Script 部署链接必须是 https://script.google.com/macros/s/.../exec。", "配置不完整");
      return false;
    }
    if (!validDatabaseUrl(databaseUrl)) {
      setStage("自动登记未启动：请填写含 gid 的 Google 表格编辑链接");
      addLog("表格链接必须是 Google Sheets 编辑链接，并包含目标工作表 gid。", "配置不完整");
      return false;
    }
    if (databaseUrl !== settings.databaseUrl) await extensionClient.saveDatabaseUrl(databaseUrl);
    return true;
  }

  async function uploadDriveBatch(batchUrls, batchStart, totalUrls) {
    const startedAt = Date.now();
    const workerCount = Math.min(DRIVE_PIPELINE_CONCURRENCY, batchUrls.length);
    const results = await mapConcurrent(batchUrls, workerCount, async (url, localIndex) => {
      try {
        return await importOneDriveFile(url, batchStart + localIndex, totalUrls);
      } catch (error) {
        const position = `${batchStart + localIndex + 1}/${totalUrls}`;
        addLog(`${position} 未预期错误：${error.message || String(error)}`, "导入失败");
        return { ok: false };
      }
    });
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
    if (!Array.isArray(sourceIds) || !sourceIds.length) return 0;
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

  function deleteNotebookSources(sourceIds: string[] = []) {
    const normalizedIds = Array.isArray(sourceIds) ? Array.from(new Set(sourceIds.filter(Boolean))) : [];
    return callPageApi("delete-sources", {
      sourceIds: normalizedIds,
      deleteAll: normalizedIds.length === 0
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

  function ensureDriveLoader() {
    if (driveLoaderReady) return driveLoaderReady;
    driveLoaderFrame = document.createElement("iframe");
    driveLoaderFrame.className = "nlm-drive-loader-frame";
    driveLoaderFrame.setAttribute("aria-hidden", "true");
    driveLoaderFrame.src = `${extensionResources.driveLoaderUrl}#token=${encodeURIComponent(DRIVE_BRIDGE_TOKEN)}`;
    driveLoaderReady = new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        resolveDriveLoaderReady = null;
        driveLoaderReady = null;
        driveLoaderFrame?.remove();
        driveLoaderFrame = null!;
        reject(new Error("Drive 下载组件未就绪。请重新加载扩展；若仍失败，请确认加载的是最新 dist 目录。"));
      }, 15000);
      resolveDriveLoaderReady = () => {
        clearTimeout(timeoutId);
        resolveDriveLoaderReady = null;
        resolve();
      };
      driveLoaderFrame.addEventListener("error", () => {
        clearTimeout(timeoutId);
        resolveDriveLoaderReady = null;
        driveLoaderReady = null;
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
      const timeoutId = window.setTimeout(() => {
        pendingDriveDownloads.delete(requestId);
        refreshDriveActivity();
        reject(new Error("Drive 文件下载超时。"));
      }, DRIVE_DOWNLOAD_TIMEOUT_MS);
      pendingDriveDownloads.set(requestId, { resolve, reject, timeoutId, position, receivedBytes: 0, totalBytes: 0 });
      refreshDriveActivity();
      driveLoaderFrame.contentWindow!.postMessage({
        source: APP_ID,
        target: "drive-loader",
        type: "drive-download-request",
        token: DRIVE_BRIDGE_TOKEN,
        requestId,
        url
      }, extensionResources.extensionOrigin);
    });
  }

  function normalizeDriveBatchSize(value) {
    return normalizeBatchSize(value, {
      defaultValue: DEFAULT_DRIVE_BATCH_SIZE,
      min: MIN_DRIVE_BATCH_SIZE,
      max: MAX_DRIVE_BATCH_SIZE
    });
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
      const cachedSourceIds = Array.from(new Set(state.records
        .filter((record) => record.sourceId && record.transcript && !record.error)
        .map((record) => record.sourceId)));
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
      const message = error instanceof Error ? error.message : String(error);
      setStage(`提取失败：${message}`);
      addLog(message, "失败");
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStage(message);
      addLog(message, "AI 翻译已暂停");
    } finally {
      state.isBusy = false;
      render();
    }
  }

  async function translateRecords(options: {
    sourceIds?: string[];
    shouldPause?: () => boolean;
    onBatchStart?: (records: TranscriptRecord[]) => void | Promise<void>;
    onBatchComplete?: (records: TranscriptRecord[]) => void | Promise<void>;
  } = {}) {
    const requestedSourceIds = new Set(Array.isArray(options.sourceIds) ? options.sourceIds.filter(Boolean) : []);
    const records = state.records.filter((record) => {
      if (!record.transcript || record.error || record.translation) return false;
      return !requestedSourceIds.size || requestedSourceIds.has(record.sourceId);
    });
    const summary = emptyTranslationSummary();
    if (!records.length) return summary;

    const originalSelection = captureSourceSelection(document);
    try {
      const batchSize = normalizeAiTranslationBatchSize(state.translationBatchSize);
      for (let offset = 0; offset < records.length; offset += batchSize) {
        if (options.shouldPause?.()) {
          summary.paused = true;
          break;
        }
        const batch = records.slice(offset, offset + batchSize);
        const batchLabel = `${Math.floor(offset / batchSize) + 1}/${Math.ceil(records.length / batchSize)}`;
        setStage(`AI 翻译批次 ${batchLabel}（${batch.length} 个来源）…`);
        addLog(`AI 翻译批次 ${batchLabel}：准备 ${batch.length} 个已有转录来源。`, "AI 翻译");
        await options.onBatchStart?.(batch);
        const batchSummary = await translateAiBatchWithRecovery(batch, batchLabel, true, options.shouldPause);
        summary.translated += batchSummary.translated;
        summary.failed += batchSummary.failed;
        summary.translatedSourceIds.push(...batchSummary.translatedSourceIds);
        await options.onBatchComplete?.(batch);
        render();
        if (options.shouldPause?.()) {
          summary.paused = true;
          break;
        }
      }
    } finally {
      restoreSourceSelection(originalSelection, document);
    }
    return summary;
  }

  function emptyTranslationSummary() {
    return { translated: 0, failed: 0, paused: false, translatedSourceIds: [] as string[] };
  }

  async function translateAiBatchWithRecovery(records, batchLabel, allowSplit = true, shouldPause?: () => boolean) {
    const summary = emptyTranslationSummary();
    let pending = records.slice();
    let lastError = "";

    for (let attempt = 0; pending.length && attempt <= AI_TRANSLATION_RETRY_LIMIT; attempt += 1) {
      try {
        const sourceControls = await selectSourcesForRecordsWhenReady(
          pending,
          sourceNamesMatch,
          document,
          { attempts: 8, delayMs: 750 }
        );
        if (sourceControls.missing.length) {
          sourceControls.missing.forEach((record) => {
            record.translationError = "来源已取得转录，但左侧来源列表在等待同步后仍未显示；本次暂不翻译和移除。";
            addLog(`${record.sourceName || "未命名来源"}：${record.translationError}`, "AI 翻译跳过");
          });
          summary.failed += sourceControls.missing.length;
          pending = sourceControls.selected;
        }
        if (!pending.length) break;

        await wait(220);
        if (!sourcesAreSelected(pending, document)) {
          throw new Error("NotebookLM 未能切换到当前翻译来源，请重试。");
        }
        const payload = await submitNotebookAiTranslationPrompt(shouldPause);
        const result = mergeTranslationPayload(payload, pending);
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
        if (error instanceof AiTranslationPauseError) throw error;
        lastError = error && error.message ? error.message : String(error);
        addLog(`批次 ${batchLabel} 第 ${attempt + 1} 次请求失败：${lastError}`, "AI 翻译失败");
        if (error instanceof AiTranslationPageStateError) throw error;
      }
    }

    if (pending.length && allowSplit && pending.length > AI_TRANSLATION_SPLIT_SIZE) {
      addLog(`批次 ${batchLabel} 未完成 ${pending.length} 条，拆分为最多 ${AI_TRANSLATION_SPLIT_SIZE} 条后重试。`, "AI 翻译恢复");
      for (let index = 0; index < pending.length; index += AI_TRANSLATION_SPLIT_SIZE) {
        const child = await translateAiBatchWithRecovery(
          pending.slice(index, index + AI_TRANSLATION_SPLIT_SIZE),
          `${batchLabel}.${Math.floor(index / AI_TRANSLATION_SPLIT_SIZE) + 1}`,
          false,
          shouldPause
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

  async function submitNotebookAiTranslationPrompt(shouldPause?: () => boolean) {
    if (shouldPause?.()) throw new AiTranslationPauseError();
    let input = findChatInput(document, state.root);
    if (!input) {
      await waitForCondition(() => Boolean(shouldPause?.() || findChatInput(document, state.root)), 30_000, 250);
      if (shouldPause?.()) throw new AiTranslationPauseError();
      input = findChatInput(document, state.root);
    }
    const chatPanel = findChatPanel(input, document);
    if (!input) {
      const generating = isNotebookAiGenerating(document, findChatPanel(null, document), state.root);
      throw new AiTranslationPageStateError(generating
        ? "NotebookLM 仍在生成上一批回答，AI 翻译队列已暂停；请等待回答完成后再继续。"
        : "未找到 NotebookLM 对话输入框，AI 翻译队列已暂停；请确认笔记本页面加载完成后重试。");
    }
    const knownPayloads = new Set<string>(getAiResponseTexts(chatPanel || document)
      .flatMap((text) => extractJsonArrayCandidates(text).map((item) => item.raw)));
    const knownResponseCount = getAiResponseTexts(chatPanel || document).length;
    const knownUserMessageCount = getUserMessageTexts(chatPanel || document).length;
    const prompt = buildTranslationPrompt();
    let started = await dispatchNotebookAiPrompt(
      input,
      chatPanel,
      prompt,
      knownUserMessageCount,
      knownResponseCount
    );
    if (!started) {
      addLog("NotebookLM 第一次没有接受翻译提示，正在自动重填并重发。", "AI 翻译重发");
      input = findChatInput(document, state.root);
      if (input) {
        started = await dispatchNotebookAiPrompt(
          input,
          chatPanel,
          prompt,
          knownUserMessageCount,
          knownResponseCount
        );
      }
    }
    if (!started) {
      throw new AiTranslationPageStateError(
        "NotebookLM 未接受翻译提示，AI 翻译队列已暂停；请确认对话框可正常发送后重试。"
      );
    }
    return waitForNotebookAiJson(chatPanel || document, knownPayloads, knownResponseCount, shouldPause);
  }

  async function dispatchNotebookAiPrompt(input, chatPanel, prompt, knownUserMessageCount, knownResponseCount) {
    setNativeTextareaValue(input, prompt);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const ready = await waitForCondition(() => {
      const submit = findChatSubmit(input, chatPanel, document, state.root);
      return Boolean(submit && !submit.disabled);
    }, 6000, 100);
    if (!ready) return false;
    const submit = findChatSubmit(input, chatPanel, document, state.root);
    if (!submit) return false;
    submit.click();
    return waitForCondition(() => {
      const responseRoot = chatPanel || document;
      return getUserMessageTexts(responseRoot).length > knownUserMessageCount ||
        getAiResponseTexts(responseRoot).length > knownResponseCount ||
        isNotebookAiGenerating(document, findChatPanel(null, document), state.root);
    }, 12_000, 200);
  }

  function setNativeTextareaValue(textarea, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (!descriptor || typeof descriptor.set !== "function") throw new Error("无法写入 NotebookLM 对话框。");
    descriptor.set.call(textarea, value);
  }

  async function waitForNotebookAiJson(chatPanel, knownPayloads, knownResponseCount, shouldPause?: () => boolean) {
    const deadline = Date.now() + AI_TRANSLATION_TIMEOUT_MS;
    let stableRaw = "";
    let stableSince = 0;
    let responseStarted = false;
    let generationObserved = false;
    while (Date.now() < deadline) {
      const responseTexts = getAiResponseTexts(chatPanel);
      if (responseTexts.length > knownResponseCount) responseStarted = true;
      const generating = isNotebookAiGenerating(document, findChatPanel(null, document), state.root);
      if (generating) generationObserved = true;
      const candidates = responseTexts
        .flatMap((text) => extractJsonArrayCandidates(text))
        .filter((item) => !knownPayloads.has(item.raw))
        .filter((item) => item.value.some((row) => {
          const candidate = row as { source_name?: unknown; zh?: unknown } | null;
          return Boolean(candidate && typeof candidate.source_name === "string" &&
            typeof candidate.zh === "string" && candidate.zh.trim() &&
            !["完整中文翻译", "完整简体中文翻译"].includes(candidate.zh.trim()));
        }));
      const newest = candidates[candidates.length - 1];
      if (newest) {
        if (newest.raw !== stableRaw) {
          stableRaw = newest.raw;
          stableSince = Date.now();
        } else if ((responseStarted || generationObserved) && !generating &&
          Date.now() - stableSince >= AI_TRANSLATION_SETTLE_MS && findChatInput(document, state.root)) {
          return newest.value;
        }
      }
      if (shouldPause?.() && !generating && !newest) throw new AiTranslationPauseError();
      await wait(AI_TRANSLATION_POLL_MS);
    }
    if (isNotebookAiGenerating(document, findChatPanel(null, document), state.root)) {
      throw new AiTranslationPageStateError("NotebookLM 在等待时限内仍未生成完回答，AI 翻译队列已暂停；当前批次不会跳过，请稍后重试。");
    }
    throw new Error("等待 NotebookLM AI 翻译超时，未收到完整 JSON 结果。");
  }

  function waitForCondition(check, timeoutMs, intervalMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = () => {
        if (check()) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        window.setTimeout(poll, intervalMs);
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
    const settings = await extensionClient.getSettings();
    const databaseUrl = panelQuery<HTMLInputElement>("[data-role='database-url']").value.trim();
    if (databaseUrl !== settings.databaseUrl) {
      await extensionClient.saveDatabaseUrl(databaseUrl);
    }
    if (!validDeploymentUrl(settings.deploymentUrl)) {
      setStage("请先在插件图标中保存有效的 Apps Script /exec 部署链接");
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
    const records = toSheetRecords(available, sourceNameToPostId);
    const batches = chunkSheetRegistrationRecords(records, databaseUrl);
    const totalBatches = batches.length;
    const statusCounts = Object.create(null);
    const failureLogs: Array<{ title: string; message: string }> = [];
    let totalSuccess = 0;
    let totalFailed = 0;
    let requestCount = 0;
    let batchStart = 0;

    try {
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
        const batchRecords = batches[batchIndex];
        const batchLabel = `${batchIndex + 1}/${totalBatches}`;
        setStage(`正在登记批次 ${batchLabel}（${batchRecords.length} 条，已按请求大小拆分）…`);
        addLog(`批次 ${batchLabel} 准备发送，共 ${batchRecords.length} 条。`, "登记");
        render();

        const attempts = await submitSheetBatchAdaptive(databaseUrl, batchRecords, batchStart, batchLabel);
        requestCount += attempts.length;
        attempts.forEach((attempt) => {
          if (attempt.error) {
            totalFailed += attempt.records.length;
            addStatusCount(statusCounts, "request_failed", attempt.records.length);
            failureLogs.push({
              title: `批次 ${attempt.batchLabel} 请求失败`,
              message: formatSheetRequestError(attempt.error, attempt.records)
            });
            return;
          }
          const analysis = analyzeBatchResponse(attempt.result as any, attempt.records, {
            batchStart: attempt.batchStart,
            batchLabel: attempt.batchLabel
          });
          mergeStatusCounts(statusCounts, analysis.statusCounts);
          totalSuccess += analysis.success;
          totalFailed += analysis.failed;
          failureLogs.push(...analysis.failureLogs);
          if (analysis.requestFailed) {
            addLog(`批次 ${attempt.batchLabel} 请求失败，已继续下一批。`, "登记失败");
            return;
          }
          addLog(`批次 ${attempt.batchLabel} 完成：成功 ${analysis.success}，失败 ${analysis.failed}。`, "批次汇总");
        });
        batchStart += batchRecords.length;
        render();
      }

      const logTime = new Date().toLocaleTimeString();
      const visibleFailures = failureLogs.slice(0, Math.max(0, MAX_LOGS - 3));
      const hiddenFailureCount = failureLogs.length - visibleFailures.length;
      state.logs = [
        { message: formatStatusCounts(statusCounts), kind: "status_counts", time: logTime },
        { message: `共 ${records.length} 条，发出 ${requestCount} 个请求；成功 ${totalSuccess}，失败 ${totalFailed}。`, kind: "登记汇总", time: logTime },
        ...(hiddenFailureCount ? [{ message: `失败明细较多，当前显示前 ${visibleFailures.length} 条，另有 ${hiddenFailureCount} 条未展开。`, kind: "显示限制", time: logTime }] : []),
        ...visibleFailures.map((entry) => ({ message: entry.message, kind: entry.title, time: logTime }))
      ].slice(0, MAX_LOGS);
      setStage(`登记完成：成功 ${totalSuccess}，失败 ${totalFailed}`);
    } finally {
      state.isBusy = false;
      render();
    }
  }

  function callPageApi(action: NotebookAction, payload: Record<string, any>, timeoutMs: number) {
    return callNotebookPageApi(action, payload, (stage) => {
      if (/上传临时失败/.test(stage)) addLog(stage, "自动重试");
      if (stage && !state.driveActivity.upload) setStage(stage);
    }, timeoutMs);
  }

  function callSheetUpsert(databaseUrl, records) {
    return extensionClient.upsertSheet({ databaseUrl, records });
  }

  async function submitSheetBatchAdaptive(databaseUrl, records, batchStart, batchLabel) {
    try {
      const result = await callSheetUpsert(databaseUrl, records);
      if (isSheetRequestTooLarge(result) && records.length > 1) {
        return splitOversizedSheetBatch(databaseUrl, records, batchStart, batchLabel);
      }
      return [{ records, batchStart, batchLabel, result }];
    } catch (error) {
      if (isSheetRequestTooLarge(error) && records.length > 1) {
        return splitOversizedSheetBatch(databaseUrl, records, batchStart, batchLabel);
      }
      return [{ records, batchStart, batchLabel, error }];
    }
  }

  async function splitOversizedSheetBatch(databaseUrl, records, batchStart, batchLabel) {
    const splitAt = Math.ceil(records.length / 2);
    const left = records.slice(0, splitAt);
    const right = records.slice(splitAt);
    addLog(`批次 ${batchLabel} 超过服务请求大小限制，自动拆分为 ${left.length} 条和 ${right.length} 条重试。`, "登记自动拆分");
    const leftResults = await submitSheetBatchAdaptive(databaseUrl, left, batchStart, `${batchLabel}.1`);
    const rightResults = await submitSheetBatchAdaptive(databaseUrl, right, batchStart + left.length, `${batchLabel}.2`);
    return [...leftResults, ...rightResults];
  }

  function formatSheetRequestError(error, records) {
    const details = error?.details || {};
    return [
      `error.code: ${details.code || (isSheetRequestTooLarge(error) ? "REQUEST_TOO_LARGE" : "REQUEST_FAILED")}`,
      `http_status: ${details.http_status || (isSheetRequestTooLarge(error) ? 413 : "未知")}`,
      `message: ${error?.message || String(error)}`,
      details.response_preview ? `response_preview: ${details.response_preview}` : "",
      `未登记 post_id：${summarizeSheetPostIds(records)}`
    ].filter(Boolean).join("\n");
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

  function sourceNameToPostId(sourceName: string) {
    return stripSourceSuffix(sourceName);
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
    const translateToggle = panelQuery<HTMLInputElement>("[data-role='translate-toggle']");
    translateToggle.checked = state.translateEnabled;
    translateToggle.disabled = state.isBusy;
    const translationBatchInput = panelQuery<HTMLInputElement>("[data-role='translation-batch-size']");
    translationBatchInput.value = String(state.translationBatchSize);
    translationBatchInput.disabled = state.isBusy;
    const autoDeleteToggle = panelQuery<HTMLInputElement>("[data-role='auto-delete-toggle']");
    autoDeleteToggle.checked = state.autoDeleteImported;
    autoDeleteToggle.disabled = state.isBusy;
    const autoRegisterToggle = panelQuery<HTMLInputElement>("[data-role='auto-register-toggle']");
    autoRegisterToggle.checked = state.autoRegisterImported;
    autoRegisterToggle.disabled = state.isBusy;
    state.root.querySelectorAll<HTMLButtonElement>("button:not([data-action='minimize']):not([data-action='show-results']):not([data-action='show-logs']):not([data-action='toggle-bottom']):not([data-action='cancel-facebook'])").forEach((button) => { button.disabled = state.isBusy; });
    const facebookCancel = panelQuery<HTMLButtonElement>("[data-action='cancel-facebook']");
    facebookCancel.hidden = !state.facebookActive;
    facebookCancel.disabled = !state.facebookActive || facebookPauseRequested;
    const driveInput = panelQuery<HTMLTextAreaElement>("[data-role='drive-urls']");
    if (driveInput) driveInput.disabled = state.isBusy;
    state.root.querySelectorAll<HTMLButtonElement>("[data-action='switch-import']").forEach((button) => {
      const active = button.dataset.mode === state.importMode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    panelQuery("[data-role='drive-pane']").toggleAttribute("hidden", state.importMode !== "drive");
    panelQuery("[data-role='facebook-pane']").toggleAttribute("hidden", state.importMode !== "facebook");
    const facebookImportButton = panelQuery<HTMLButtonElement>("[data-action='import-facebook']");
    const pendingFacebookTranslations = facebookJob?.translate
      ? state.records.filter((record) => record.sourceId && record.transcript && !record.error &&
        !record.translation && !record.sourceDeleted).length
      : 0;
    facebookImportButton.textContent = facebookJob && facebookJob.status !== "completed" &&
      facebookJob.nextIndex >= facebookJob.tasks.length && pendingFacebookTranslations
      ? `继续翻译 ${pendingFacebookTranslations}`
      : facebookJob && facebookJob.status !== "completed" && facebookJob.nextIndex > 0
        ? `继续导入 ${facebookJob.nextIndex}/${facebookJob.tasks.length}`
        : "开始导入";
    const batchSizeInput = panelQuery<HTMLInputElement>("[data-role='drive-batch-size']");
    if (batchSizeInput) {
      batchSizeInput.value = String(state.driveBatchSize);
      batchSizeInput.disabled = state.isBusy;
    }
    const minimizeButton = panelQuery<HTMLButtonElement>("[data-action='minimize']");
    minimizeButton.title = "最小化";
    minimizeButton.setAttribute("aria-label", "最小化");
    const successCount = getSuccessfulRecords().length;
    const failedCount = state.records.filter((record) => record.error || !record.transcript).length;
    panelQuery("[data-role='record-count']").textContent = String(state.records.length);
    panelQuery("[data-role='success-count']").textContent = String(successCount);
    panelQuery("[data-role='failed-count']").textContent = String(failedCount);
    panelQuery("[data-action='copy'] span").textContent = state.translateEnabled ? "复制三列结果" : "复制两列结果";
    renderFacebookTable();
    renderBottomPanel();
    renderStatus();
    renderLogs();
    renderResults();
  }

  function renderStatus() {
    if (!state.root) return;
    const status = panelQuery("[data-role='status']");
    if (status) status.textContent = state.stage;
    const alert = panelQuery<HTMLElement>("[data-role='top-alert']");
    const showAlert = isActionRequiredStage(state.stage);
    alert.hidden = !showAlert;
    alert.textContent = showAlert ? state.stage : "";
  }

  function isActionRequiredStage(message: string) {
    return /失败|错误|异常|无法|无效|未启动|未连接|请先|请填写|请粘贴|需要修正|不能|超过|暂停|遗留|仍有|重试/u.test(message);
  }

  function renderLogs() {
    if (!state.root) return;
    const container = panelQuery("[data-role='logs']");
    if (!container) return;
    container.innerHTML = state.logs.length
      ? state.logs.map((entry) => `<p><span>${escapeHtml(entry.kind)}</span>${escapeHtml(entry.message)}<time>${escapeHtml(entry.time)}</time></p>`).join("")
      : "<div class=\"nlm-empty-state\">暂无操作日志。</div>";
  }

  function renderResults() {
    if (!state.root) return;
    const container = panelQuery("[data-role='results']");
    if (!state.records.length) {
      container.innerHTML = "<p>尚无来源记录。</p>";
      return;
    }
    const visibleStart = Math.max(0, state.records.length - RESULT_RENDER_LIMIT);
    const visibleRecords = state.records.slice(visibleStart);
    const cards = visibleRecords.map((record, visibleIndex) => {
      const index = visibleStart + visibleIndex;
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
    const limitNotice = visibleStart
      ? `<div class="nlm-view-limit">结果共 ${state.records.length} 条，为保持流畅仅显示最近 ${visibleRecords.length} 条；复制和登记仍包含全部成功记录。</div>`
      : "";
    container.innerHTML = `${limitNotice}<div class="nlm-result-list">${cards}</div>`;
  }

  function renderBottomPanel() {
    if (!state.root) return;
    const panel = panelQuery(".nlm-bottom-panel");
    if (!panel) return;
    panel.classList.toggle("is-open", state.bottomOpen);
    const resultButton = panel.querySelector<HTMLButtonElement>("[data-action='show-results']")!;
    const logButton = panel.querySelector<HTMLButtonElement>("[data-action='show-logs']")!;
    const toggleButton = panel.querySelector<HTMLButtonElement>("[data-action='toggle-bottom']")!;
    const showingResults = state.bottomView === "results";
    resultButton.classList.toggle("is-active", showingResults);
    logButton.classList.toggle("is-active", !showingResults);
    resultButton.setAttribute("aria-selected", String(showingResults));
    logButton.setAttribute("aria-selected", String(!showingResults));
    panel.querySelector("[data-role='results-view']")!.classList.toggle("is-active", showingResults);
    panel.querySelector("[data-role='logs-view']")!.classList.toggle("is-active", !showingResults);
    panel.querySelector("[data-role='result-tab-count']")!.textContent = String(state.records.length);
    panel.querySelector("[data-role='log-tab-count']")!.textContent = String(state.logs.length);
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
    facebookJob = null;
    if (activeNotebookId) void extensionClient.clearFacebookJob(activeNotebookId);
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
      timerId = window.setTimeout(() => {
        if (state.minimized) return;
        rememberPanelLayout();
        savePanelSettings();
      }, 250);
    });
    observer.observe(state.root);
  }

  function bindDatabaseUrlInput() {
    const input = panelQuery<HTMLInputElement>("[data-role='database-url']");
    const saveState = panelQuery<HTMLElement>("[data-role='sheet-save-state']");
    let timerId = 0;
    const save = async () => {
      clearTimeout(timerId);
      state.databaseUrl = input.value.trim();
      await extensionClient.saveDatabaseUrl(state.databaseUrl);
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
      timerId = window.setTimeout(save, 450);
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
    if (typeof layout.width === "number" && Number.isFinite(layout.width)) state.root.style.width = `${Math.max(300, Math.min(layout.width, window.innerWidth - 16))}px`;
    if (typeof layout.height === "number" && Number.isFinite(layout.height)) state.root.style.height = `${Math.max(320, Math.min(layout.height, window.innerHeight - 16))}px`;
    const panelWidth = Math.min(Number(layout.width) || state.root.offsetWidth || 390, window.innerWidth - 16);
    const panelHeight = Math.min(Number(layout.height) || state.root.offsetHeight || 760, window.innerHeight - 16);
    if (typeof layout.left === "number" && Number.isFinite(layout.left)) {
      state.root.style.left = `${Math.max(8, Math.min(layout.left, window.innerWidth - panelWidth - 8))}px`;
      state.root.style.right = "auto";
    }
    if (typeof layout.top === "number" && Number.isFinite(layout.top)) {
      state.root.style.top = `${Math.max(8, Math.min(layout.top, window.innerHeight - panelHeight - 8))}px`;
    }
    keepPanelInViewport();
  }

  function keepPanelInViewport() {
    if (!state.root?.isConnected || state.minimized) return;
    const rect = state.root.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8));
    if (Math.abs(left - rect.left) > 1) {
      state.root.style.left = `${left}px`;
      state.root.style.right = "auto";
    }
    if (Math.abs(top - rect.top) > 1) state.root.style.top = `${top}px`;
  }

  async function savePanelSettings() {
    const settings: PanelSettings = {
      aiTranslationEnabled: state.translateEnabled,
      aiTranslationBatchSize: state.translationBatchSize,
      autoDeleteImported: state.autoDeleteImported,
      autoRegisterImported: state.autoRegisterImported,
      driveBatchSize: state.driveBatchSize,
      importMode: state.importMode,
      facebookImportOpen: state.importMode === "facebook",
      facebookAutoRegister: state.autoRegisterImported,
      minimized: state.minimized,
      layout: state.panelLayout || {}
    };
    await extensionClient.savePanelSettings(settings);
  }

  function brandIconMarkup(className) {
    return `<img class="${className}" data-extension-icon src="${extensionResources.iconUrl || fallbackIconDataUrl()}" alt="">`;
  }

  function fallbackIconDataUrl() {
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='18' y1='12' x2='112' y2='118' gradientUnits='userSpaceOnUse'%3E%3Cstop stop-color='%236D5DFB'/%3E%3Cstop offset='1' stop-color='%233457D5'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect x='8' y='8' width='112' height='112' rx='34' fill='url(%23g)'/%3E%3Cpath d='M36 86V47c0-4.4 5.2-6.8 8.6-4l38 32.6V42' fill='none' stroke='white' stroke-width='12' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='94' cy='92' r='12' fill='%235EEAD4' stroke='white' stroke-width='4'/%3E%3C/svg%3E";
  }
