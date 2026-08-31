import {
  extractRpcPayload,
  extractSourceRecords,
  extractTranscriptText,
  findSourceEntry,
  firstMatch,
  firstUuid,
  isRetryableUploadError,
  sourceOptions,
  summarizeSourceStatus
} from "@/lib/notebookApi";

export type NotebookAction =
  | "transcribe-single"
  | "upload-media-source"
  | "prepare-remote-media-source"
  | "get-source-summary"
  | "extract-existing-sources"
  | "delete-sources";

export type ProgressHandler = (stage: string, detail?: Record<string, unknown>) => void;

  const MAX_BODY_CHARS = 1200;
  const UPLOAD_MAX_ATTEMPTS = 3;
  const UPLOAD_RETRY_BASE_DELAY_MS = 1200;
  const RPC = {
    createSource: "o4cbdc",
    pollNotebook: "rLM1Ne",
    getTranscript: "hizoJc",
    deleteSource: "tGMBJ"
  };

  const fetchImpl = window.fetch.bind(window);

export async function callNotebookApi(
  action: NotebookAction,
  payload: Record<string, any> = {},
  progress: ProgressHandler = () => undefined
): Promise<any> {
  const client = new NotebookLmApiClient(progress);
  if (action === "transcribe-single" || action === "upload-media-source") {
    const file = payload.file;
    if (!isFileLike(file)) throw new Error("No media file was provided to the page API client.");
    return client.transcribeSingleFile(file, {
      ...(payload.options || {}),
      requireTranscript: action === "transcribe-single",
      waitForProcessing: action === "transcribe-single"
    });
  }
  if (action === "prepare-remote-media-source") return client.prepareRemoteMediaSource(payload);
  if (action === "get-source-summary") return client.getSourceSummary();
  if (action === "extract-existing-sources") return client.extractExistingSources(payload);
  if (action === "delete-sources") return client.deleteSources(payload);
  throw new Error(`Unsupported NotebookLM action: ${String(action)}`);
}

  class NotebookLmApiClient {
    progress: ProgressHandler;
    params: any;
    reqid: number;
    lastRpc: string;

    constructor(progress: ProgressHandler) {
      this.progress = progress;
      this.params = extractRuntimeParams();
      this.reqid = Math.floor(Math.random() * 900000) + 100000;
      this.lastRpc = "";
    }

    async transcribeSingleFile(file: File, options: any) {
      const fileName = file.name || "notebooklm-media";
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15 * 60 * 1000;
      const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 3000;
      const requireTranscript = options.requireTranscript !== false;
      const waitForProcessing = options.waitForProcessing !== false;

      this.progress("Creating NotebookLM source...", {
        lastRpc: RPC.createSource,
        detail: { fileName, projectId: this.params.projectId }
      });
      const sourceId = await this.createSource(fileName);
      this.progress("Source created.", {
        sourceId,
        lastRpc: RPC.createSource
      });

      await this.uploadSourceBytesWithRetry(file, fileName, sourceId);

      if (!waitForProcessing) {
        return {
          sourceId,
          fileName,
          transcript: "",
          uploaded: true,
          runtime: {
            projectId: this.params.projectId,
            bl: this.params.bl,
            hl: this.params.hl
          }
        };
      }

      this.progress("Waiting for NotebookLM processing...", {
        sourceId,
        lastRpc: RPC.pollNotebook,
        pollCount: 0
      });
      const pollInfo = await this.waitForSourceReady(sourceId, timeoutMs, pollIntervalMs, fileName);

      this.progress("Fetching source transcript...", {
        sourceId,
        pollCount: pollInfo.pollCount,
        lastRpc: RPC.getTranscript
      });
      let transcriptPayload: any = null;
      let transcript = "";
      try {
        transcriptPayload = await this.getSourceDetail(sourceId);
        transcript = extractTranscriptText(transcriptPayload, {
          sourceId,
          projectId: this.params.projectId,
          fileName
        });
      } catch (error) {
        if (requireTranscript) throw error;
        sendLog("api", "warn", "Source upload succeeded but transcript lookup failed.", {
          sourceId,
          fileName,
          error: serialize(error)
        });
      }

      if (!transcript && requireTranscript) {
        const error = new Error("NotebookLM returned source details but no transcript text was found.");
        error.debug = summarizePayload(transcriptPayload);
        throw error;
      }

      return {
        sourceId,
        fileName,
        transcript,
        pollCount: pollInfo.pollCount,
        lastRpc: RPC.getTranscript,
        runtime: {
          projectId: this.params.projectId,
          bl: this.params.bl,
          hl: this.params.hl
        }
      };
    }

    async uploadSourceBytesWithRetry(file: File, fileName: string, sourceId: string) {
      let lastError;
      for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
        try {
          this.progress(`Starting resumable upload (${attempt}/${UPLOAD_MAX_ATTEMPTS})...`, {
            sourceId,
            detail: { fileName, attempt }
          });
          const uploadUrl = await this.startUpload({ size: file.size, type: file.type }, fileName, sourceId);
          this.progress(`Uploading file bytes (${attempt}/${UPLOAD_MAX_ATTEMPTS})...`, {
            sourceId,
            detail: { fileName, attempt }
          });
          await this.uploadBytes(uploadUrl, file);
          return;
        } catch (error) {
          lastError = error;
          if (attempt >= UPLOAD_MAX_ATTEMPTS || !isRetryableUploadError(error)) throw error;
          const delayMs = UPLOAD_RETRY_BASE_DELAY_MS * attempt;
          sendLog("api", "warn", "Upload attempt failed; retrying with the same source ID.", {
            sourceId,
            fileName,
            attempt,
            delayMs,
            error: serialize(error)
          });
          this.progress(`上传临时失败，${Math.ceil(delayMs / 1000)} 秒后重试（${attempt + 1}/${UPLOAD_MAX_ATTEMPTS}）…`, {
            sourceId,
            detail: { fileName, attempt, delayMs }
          });
          await wait(delayMs);
        }
      }
      throw lastError || new Error("Upload failed.");
    }

    async prepareRemoteMediaSource(payload: Record<string, any>) {
      const fileName = String(payload.fileName || "").trim();
      const size = Number(payload.size);
      const type = String(payload.type || "application/octet-stream").trim();
      if (!fileName) throw new Error("远程媒体缺少文件名。");
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error("远程媒体大小无效。");
      if (!/^(?:audio|video)\/[a-z0-9.+-]+$/iu.test(type)) throw new Error("远程媒体 MIME 类型无效。");

      let sourceId = "";
      try {
        sourceId = await this.createSource(fileName);
        const uploadUrl = await this.startUpload({ size, type }, fileName, sourceId);
        return { sourceId, fileName, size, type, uploadUrl };
      } catch (error) {
        if (sourceId) {
          try {
            await this.batchexecute(RPC.deleteSource, [[[sourceId]], [2]]);
          } catch (cleanupError) {
            sendLog("api", "warn", "Failed to remove a remote source after upload-session preparation failed.", {
              sourceId,
              error: serialize(cleanupError)
            });
          }
        }
        throw error;
      }
    }

    async getSourceSummary() {
      const notebookPayload = await this.getNotebookState();
      const sources = extractSourceRecords(notebookPayload, this.params.projectId, extractVisibleSourceNames());
      return {
        totalSources: sources.length,
        sourceIds: sources.map((source) => source.sourceId)
      };
    }

    async extractExistingSources(options: any = {}) {
      this.progress("正在读取笔记本来源列表…", {
        lastRpc: RPC.pollNotebook
      });
      const notebookPayload = await this.getNotebookState();
      const allSources = extractSourceRecords(notebookPayload, this.params.projectId, extractVisibleSourceNames());
      const requestedIds = new Set<string>(Array.isArray(options.sourceIds) ? options.sourceIds.filter(Boolean) : []);
      const skippedIds = new Set<string>(Array.isArray(options.skipSourceIds) ? options.skipSourceIds.filter(Boolean) : []);
      const sourceNames = options.sourceNames && typeof options.sourceNames === "object" ? options.sourceNames : {};
      const waitForReady = options.waitForReady === true;
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15 * 60 * 1000;
      const overallTimeoutMs = Number.isFinite(options.overallTimeoutMs) ? options.overallTimeoutMs : timeoutMs;
      const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 3000;
      const deadline = waitForReady ? Date.now() + overallTimeoutMs : Number.POSITIVE_INFINITY;
      let sources = allSources.filter((source) => !skippedIds.has(source.sourceId));

      if (requestedIds.size) {
        const existingById = new Map(allSources.map((source) => [source.sourceId, source]));
        sources = Array.from(requestedIds).map((sourceId, index) => existingById.get(sourceId) || {
          sourceId,
          sourceName: sourceNames[sourceId] || `新增来源 ${index + 1}`
        });
      }
      if (!sources.length) {
        return {
          records: [],
          totalSources: allSources.length,
          skipped: allSources.filter((source) => skippedIds.has(source.sourceId)).length,
          lastRpc: RPC.getTranscript
        };
      }

      const records: any[] = [];
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const sourceName = source.sourceName || `来源 ${index + 1}`;
        this.progress(`正在读取 ${index + 1}/${sources.length}：${sourceName}`, {
          sourceName,
          sourceId: source.sourceId,
          lastRpc: RPC.getTranscript
        });

        try {
          if (waitForReady) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
              const timeoutError = new Error(`本批来源处理已达到 ${Math.ceil(overallTimeoutMs / 60000)} 分钟上限。`);
              timeoutError.code = "BATCH_PROCESSING_TIMEOUT";
              throw timeoutError;
            }
            await this.waitForSourceReady(
              source.sourceId,
              Math.min(timeoutMs, remainingMs),
              pollIntervalMs,
              sourceName
            );
          } else {
            const visibleFailure = findVisibleSourceFailure(sourceName);
            if (visibleFailure) throw createSourceProcessingError(visibleFailure);
          }
          const transcriptPayload = await this.getSourceDetail(source.sourceId);
          const transcript = extractTranscriptText(transcriptPayload, {
            sourceId: source.sourceId,
            projectId: this.params.projectId,
            fileName: sourceName
          });
          if (!transcript) {
            throw new Error("NotebookLM returned source details but no transcript text was found.");
          }
          records.push({ sourceId: source.sourceId, sourceName, transcript });
        } catch (error) {
          records.push({
            sourceId: source.sourceId,
            sourceName,
            transcript: "",
            error: error && error.message ? error.message : String(error)
          });
          sendLog("api", "warn", "Could not extract one source transcript.", {
            sourceId: source.sourceId,
            sourceName,
            error: serialize(error)
          });
        }
      }

      return {
        records,
        totalSources: allSources.length,
        skipped: allSources.filter((source) => skippedIds.has(source.sourceId)).length,
        lastRpc: RPC.getTranscript
      };
    }

    async deleteSources(options: any = {}) {
      this.progress("正在读取待移除来源…", {
        lastRpc: RPC.pollNotebook
      });
      const notebookPayload = await this.getNotebookState();
      const allSources = extractSourceRecords(notebookPayload, this.params.projectId, extractVisibleSourceNames());
      const sourceById = new Map(allSources.map((source) => [source.sourceId, source]));
      const requestedIds: string[] = Array.isArray(options.sourceIds)
        ? Array.from(new Set<string>(options.sourceIds.filter(Boolean)))
        : [];
      if (!requestedIds.length && options.deleteAll !== true) {
        throw new Error("删除全部来源必须显式确认 deleteAll。");
      }
      const targets = requestedIds.length
        ? requestedIds.map((sourceId) => sourceById.get(sourceId) || { sourceId, sourceName: sourceId })
        : allSources;
      const deleted: string[] = [];
      const failed: any[] = [];

      for (let index = 0; index < targets.length; index += 1) {
        const source = targets[index];
        this.progress(`正在移除 ${index + 1}/${targets.length}：${source.sourceName || source.sourceId}`, {
          sourceId: source.sourceId,
          sourceName: source.sourceName,
          lastRpc: RPC.deleteSource
        });
        try {
          await this.batchexecute(RPC.deleteSource, [[[source.sourceId]], [2]]);
          deleted.push(source.sourceId);
        } catch (error) {
          failed.push({
            sourceId: source.sourceId,
            sourceName: source.sourceName,
            error: error && error.message ? error.message : String(error)
          });
        }
      }

      return {
        requested: targets.length,
        deleted,
        failed,
        lastRpc: RPC.deleteSource
      };
    }

    async createSource(fileName) {
      const payload = [
        [[fileName]],
        this.params.projectId,
        sourceOptions()
      ];
      sendLog("api", "debug", "Calling create-source RPC.", {
        rpcid: RPC.createSource,
        fileName,
        projectId: this.params.projectId
      });
      const result = await this.batchexecute(RPC.createSource, payload);
      const sourceId = firstUuid(JSON.stringify(result), this.params.projectId);
      if (!sourceId) {
        const error = new Error("Could not read sourceId from create-source response.");
        error.debug = summarizePayload(result);
        throw error;
      }
      return sourceId;
    }

    async startUpload(file: { size: number; type?: string }, fileName, sourceId) {
      sendLog("api", "debug", "Starting resumable upload.", {
        size: file.size,
        type: file.type || "",
        fileName,
        sourceId
      });
      const response = await fetchImpl(`/upload/_/?authuser=${encodeURIComponent(this.params.authuser)}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-Goog-AuthUser": this.params.authuser,
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(file.size),
          "X-Goog-Upload-Header-Content-Type": file.type || "application/octet-stream",
          "X-Goog-Upload-Protocol": "resumable"
        },
        body: JSON.stringify({
          PROJECT_ID: this.params.projectId,
          SOURCE_NAME: fileName,
          SOURCE_ID: sourceId
        })
      });

      if (!response.ok) {
        const error = new Error(`Upload start failed with HTTP ${response.status}.`);
        error.debug = {
          status: response.status,
          statusText: response.statusText,
          body: await readResponsePreview(response)
        };
        throw error;
      }

      const uploadUrl = response.headers.get("x-goog-upload-url") || response.headers.get("x-goog-upload-control-url");
      if (!uploadUrl) {
        const error = new Error("Upload start response did not include x-goog-upload-url.");
        error.debug = {
          status: response.status,
          statusText: response.statusText,
          headers: Array.from(response.headers.keys())
        };
        throw error;
      }
      sendLog("api", "debug", "Received resumable upload URL.", {
        sourceId,
        hasUploadUrl: Boolean(uploadUrl)
      });
      return uploadUrl;
    }

    async uploadBytes(uploadUrl, file) {
      const response = await fetchImpl(uploadUrl, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Goog-AuthUser": this.params.authuser,
          "X-Goog-Upload-Command": "upload, finalize",
          "X-Goog-Upload-Offset": "0"
        },
        body: file
      });

      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`Upload finalize failed with HTTP ${response.status}.`);
        error.debug = {
          status: response.status,
          statusText: response.statusText,
          body: text.slice(0, 1000)
        };
        throw error;
      }
      if (!/ok|enqueued|final/i.test(text)) {
        sendLog("api", "warn", "Upload finalize response was unexpected.", { response: text.slice(0, 500) });
      } else {
        sendLog("api", "debug", "Upload finalized.", { response: text.slice(0, 300) });
      }
    }

    async waitForSourceReady(sourceId, timeoutMs, pollIntervalMs, sourceName = "") {
      const started = Date.now();
      let pollCount = 0;
      let lastSource: unknown[] | null = null;
      let sourceWasVisible = false;
      let missingAfterVisible = 0;

      while (Date.now() - started < timeoutMs) {
        pollCount += 1;
        const visibleFailure = findVisibleSourceFailure(sourceName);
        if (visibleFailure) {
          const error = createSourceProcessingError(visibleFailure);
          error.debug = { sourceId, sourceName, pollCount, detection: "visible-error-container" };
          throw error;
        }

        const payload = await this.getNotebookState();
        const source = findSourceEntry(payload, sourceId);
        lastSource = source || lastSource;
        const status = source ? summarizeSourceStatus(source) : null;
        if (source) {
          sourceWasVisible = true;
          missingAfterVisible = 0;
        } else if (sourceWasVisible) {
          missingAfterVisible += 1;
        }

        this.progress(`Waiting for processing (${pollCount})...`, {
          sourceId,
          pollCount,
          lastRpc: RPC.pollNotebook,
          detail: status
        });

        if (status && status.failed) {
          const error = createSourceProcessingError({
            sourceName: sourceName || sourceId,
            message: "NotebookLM 返回来源处理失败状态。"
          });
          error.debug = { sourceId, sourceName, pollCount, detection: "source-status-code", status };
          throw error;
        }
        if (status && status.ready) {
          return { pollCount, source, status };
        }
        if (missingAfterVisible >= 3) {
          const error = new Error("NotebookLM 来源在处理过程中消失，已停止等待。");
          error.code = "SOURCE_DISAPPEARED";
          error.debug = { sourceId, sourceName, pollCount, lastSource: summarizePayload(lastSource) };
          throw error;
        }

        await wait(pollIntervalMs);
      }

      const error = new Error(`NotebookLM 处理来源超时（等待 ${Math.ceil(timeoutMs / 60000)} 分钟）。`);
      error.code = "SOURCE_PROCESSING_TIMEOUT";
      error.debug = {
        sourceId,
        pollCount,
        lastSource: summarizePayload(lastSource)
      };
      throw error;
    }

    async getNotebookState() {
      const payload = [
        this.params.projectId,
        null,
        sourceOptions(),
        null,
        1,
        [[null, null, []]]
      ];
      return this.batchexecute(RPC.pollNotebook, payload);
    }

    async getSourceDetail(sourceId) {
      const payload = [
        [sourceId],
        [2],
        sourceOptions()
      ];
      return this.batchexecute(RPC.getTranscript, payload);
    }

    async batchexecute(rpcid, payload) {
      this.lastRpc = rpcid;
      const url = new URL("/_/LabsTailwindUi/data/batchexecute", window.location.origin);
      url.searchParams.set("rpcids", rpcid);
      url.searchParams.set("source-path", this.params.sourcePath);
      url.searchParams.set("bl", this.params.bl);
      url.searchParams.set("f.sid", this.params.fsid);
      url.searchParams.set("hl", this.params.hl);
      url.searchParams.set("_reqid", String(this.nextReqid()));
      url.searchParams.set("rt", "c");

      const body = new URLSearchParams();
      body.set("f.req", JSON.stringify([[[rpcid, JSON.stringify(payload), null, "generic"]]]));
      body.set("at", this.params.at);

      const response = await fetchImpl(url.toString(), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-Same-Domain": "1"
        },
        body
      });

      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${rpcid} failed with HTTP ${response.status}.`);
        error.debug = {
          status: response.status,
          statusText: response.statusText,
          body: text.slice(0, 1500)
        };
        throw error;
      }

      const rpcPayload = extractRpcPayload(text, rpcid, (error, line) => {
        sendLog("parser", "warn", "Could not parse batchexecute chunk.", {
          error: error.message,
          preview: String(line || "").slice(0, 300)
        });
      });
      sendLog("api", "debug", "RPC completed.", {
        rpcid,
        summary: summarizePayload(rpcPayload)
      });
      return rpcPayload;
    }

    nextReqid() {
      this.reqid += 100000;
      return this.reqid;
    }
  }

  function isFileLike(file) {
    return file &&
      typeof file === "object" &&
      typeof file.name === "string" &&
      typeof file.size === "number" &&
      typeof file.arrayBuffer === "function";
  }

  async function readResponsePreview(response) {
    try {
      const text = await response.text();
      return text.slice(0, 1000);
    } catch (error) {
      return `[unreadable response body: ${error.message}]`;
    }
  }

  function extractRuntimeParams() {
    const projectMatch = window.location.pathname.match(/\/notebook\/([^/?#]+)/);
    const projectId = projectMatch && projectMatch[1];
    const runtimeText = collectRuntimeText();
    const globalAt = window.WIZ_global_data && typeof window.WIZ_global_data.SNlM0e === "string"
      ? window.WIZ_global_data.SNlM0e
      : "";
    const at = globalAt ||
      extractJsonStringProperty(runtimeText, "SNlM0e") ||
      firstMatch(runtimeText, /AABr[a-zA-Z0-9_\-:.]+/);
    const bl = firstMatch(runtimeText, /boq_labs-tailwind-frontend_[0-9A-Za-z_.-]+/) ||
      extractQueryParamFromRuntimeText(runtimeText, "bl");
    const fsid = extractQueryParamFromRuntimeText(runtimeText, "f.sid") ||
      firstMatch(runtimeText, /f\.sid[=:"'\s]+(-?\d{8,})/) ||
      firstMatch(runtimeText, /"f\.sid","(-?\d{8,})"/);
    const authuserCandidate = new URLSearchParams(window.location.search).get("authuser") ||
      extractQueryParamFromRuntimeText(runtimeText, "authuser") || "0";
    const authuser = /^\d+$/.test(authuserCandidate) ? authuserCandidate : "0";
    const hl = (document.documentElement.lang || navigator.language || "en-GB").replace("_", "-");

    const missing: string[] = [];
    if (!projectId) missing.push("projectId");
    if (!at) missing.push("at");
    if (!bl) missing.push("bl");
    if (!fsid) missing.push("f.sid");
    if (missing.length) {
      throw new Error(`Missing NotebookLM runtime parameter(s): ${missing.join(", ")}. Refresh NotebookLM and try again.`);
    }

    return {
      projectId,
      at,
      bl,
      fsid,
      authuser,
      hl,
      sourcePath: `/notebook/${projectId}`
    };
  }

  function collectRuntimeText() {
    const parts = [
      window.location.href,
      document.documentElement.innerHTML
    ];

    try {
      for (const entry of performance.getEntriesByType("resource")) {
        if (entry && entry.name) {
          parts.push(entry.name);
        }
      }
    } catch (_error) {
      // Performance entries are a best-effort fallback.
    }

    return parts.join("\n");
  }

  function extractJsonStringProperty(text, name) {
    const escapedName = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`"${escapedName}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`);
    const match = String(text || "").match(regex);
    if (!match) return "";
    try {
      const value = JSON.parse(match[1]);
      return typeof value === "string" ? value : "";
    } catch (_error) {
      return "";
    }
  }

  function extractQueryParamFromRuntimeText(text, name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`[?&]${escapedName}=([^&#\\s"']+)`);
    const match = String(text || "").match(regex);
    if (!match) {
      return "";
    }
    try {
      return decodeURIComponent(match[1]);
    } catch (_error) {
      return match[1];
    }
  }

  function extractVisibleSourceNames() {
    const blacklist = new Set(["More", "Select all", "Add sources", "Collapse source panel"]);
    return Array.from(document.querySelectorAll("button"))
      .map((button) => (button.getAttribute("aria-label") || button.textContent || "").trim())
      .filter((name) => name && !blacklist.has(name))
      .filter((name) => /(?:https?;|https?:\/\/|www\.|\.(?:mp3|mp4|m4a|wav|pdf|docx?|txt|csv|pptx?|xlsx?))$/i.test(name));
  }

  function findVisibleSourceFailure(sourceName) {
    const failedContainers = Array.from(document.querySelectorAll(".single-source-container.single-source-error-container"));
    if (!failedContainers.length) return null;
    const expectedName = String(sourceName || "").trim();
    const container = failedContainers.find((item) => {
      const sourceButton = item.querySelector("button.source-stretched-button");
      const visibleName = sourceButton
        ? String(sourceButton.getAttribute("aria-label") || "").trim()
        : String((item.querySelector(".source-title") || {}).textContent || "").trim();
      return expectedName ? visibleName === expectedName : failedContainers.length === 1;
    });
    if (!container) return null;
    const sourceButton = container.querySelector("button.source-stretched-button");
    const visibleName = sourceButton
      ? String(sourceButton.getAttribute("aria-label") || expectedName).trim()
      : expectedName;
    return {
      sourceName: visibleName || expectedName || "未命名来源",
      message: "NotebookLM 已将该来源标记为处理失败，可能是媒体编码、文件损坏或服务处理异常。"
    };
  }

  function createSourceProcessingError(failure) {
    const error = new Error(`${failure.sourceName}：${failure.message}`);
    error.code = "SOURCE_PROCESSING_FAILED";
    return error;
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function sendLog(scope, level, detail, explicitDetail) {
    if (!import.meta.env.DEV) return;
    const method = level === "warn" || level === "error" ? level : "debug";
    console[method](`[NotebookLM:${scope}]`, detail, explicitDetail ?? "");
  }

  function serialize(value) {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
        debug: value.debug
      };
    }
    if (Array.isArray(value)) {
      return value.map(serialize);
    }
    if (value && typeof value === "object") {
      try {
        return JSON.parse(safeStringify(value));
      } catch (_error) {
        return String(value);
      }
    }
    return value;
  }

  function safeStringify(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === "function") {
        return `[Function ${nestedValue.name || "anonymous"}]`;
      }
      if (nestedValue instanceof Error) {
        return serialize(nestedValue);
      }
      if (nestedValue && typeof nestedValue === "object") {
        if (seen.has(nestedValue)) {
          return "[Circular]";
        }
        seen.add(nestedValue);
      }
      return nestedValue;
    });
  }

  function summarizePayload(payload) {
    const text = safeStringify(payload);
    return {
      type: Array.isArray(payload) ? "array" : typeof payload,
      length: Array.isArray(payload) ? payload.length : undefined,
      preview: text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}...` : text
    };
  }
