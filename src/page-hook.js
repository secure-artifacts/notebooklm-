(function () {
  "use strict";

  const APP_ID = "nlm-video-translation-helper";
  const BRIDGE_TOKEN = document.currentScript && document.currentScript.dataset
    ? String(document.currentScript.dataset.bridgeToken || "")
    : "";
  const MAX_BODY_CHARS = 1200;
  const RPC = {
    createSource: "o4cbdc",
    pollNotebook: "rLM1Ne",
    getTranscript: "hizoJc",
    deleteSource: "tGMBJ"
  };

  if (window.__nlmVideoTranslationHelperHooked) {
    return;
  }
  window.__nlmVideoTranslationHelperHooked = true;

  const originalFetch = window.fetch;
  const fetchImpl = typeof originalFetch === "function"
    ? originalFetch.bind(window)
    : window.fetch.bind(window);

  installConsoleHook();
  installNetworkHook();
  window.addEventListener("message", handleApiRequest);
  sendLog("page", "info", "Page hook installed.");

  function installConsoleHook() {
    const originalConsole = {};
    ["debug", "log", "info", "warn", "error"].forEach((level) => {
      originalConsole[level] = console[level];
      console[level] = function (...args) {
        sendLog("console", level, args);
        return originalConsole[level].apply(console, args);
      };
    });
  }

  function installNetworkHook() {
    if (typeof originalFetch === "function") {
      window.fetch = async function (...args) {
        const started = Date.now();
        const request = normalizeFetchRequest(args);
        try {
          const response = await originalFetch.apply(this, args);
          sendLog("network", response.ok ? "info" : "warn", {
            kind: "fetch",
            request,
            response: {
              status: response.status,
              statusText: response.statusText,
              url: response.url,
              elapsedMs: Date.now() - started
            }
          });
          return response;
        } catch (error) {
          sendLog("network", "error", {
            kind: "fetch",
            request,
            error: serialize(error),
            elapsedMs: Date.now() - started
          });
          throw error;
        }
      };
    }

    const OriginalXHR = window.XMLHttpRequest;
    if (typeof OriginalXHR !== "function") {
      return;
    }

    window.XMLHttpRequest = function () {
      const xhr = new OriginalXHR();
      const meta = {
        method: "GET",
        url: "",
        started: 0
      };
      const headers = {};
      const originalOpen = xhr.open;
      const originalSend = xhr.send;
      const originalSetHeader = xhr.setRequestHeader;

      xhr.open = function (method, url, ...rest) {
        meta.method = method || "GET";
        meta.url = String(url || "");
        return originalOpen.call(xhr, method, url, ...rest);
      };

      xhr.setRequestHeader = function (name, value) {
        headers[name] = redactHeader(name, value);
        return originalSetHeader.call(xhr, name, value);
      };

      xhr.send = function (body) {
        meta.started = Date.now();
        sendLog("network", "debug", {
          kind: "xhr:start",
          request: {
            method: meta.method,
            url: meta.url,
            headers,
            body: summarizeBody(body)
          }
        });
        return originalSend.call(xhr, body);
      };

      xhr.addEventListener("loadend", () => {
        sendLog("network", xhr.status >= 400 ? "warn" : "info", {
          kind: "xhr:end",
          request: {
            method: meta.method,
            url: meta.url,
            headers
          },
          response: {
            status: xhr.status,
            statusText: xhr.statusText,
            responseURL: xhr.responseURL,
            elapsedMs: meta.started ? Date.now() - meta.started : null
          }
        });
      });

      return xhr;
    };
    window.XMLHttpRequest.prototype = OriginalXHR.prototype;
  }

  async function handleApiRequest(event) {
    if (event.source !== window || !event.data || event.data.source !== APP_ID || event.data.target !== "page" || event.data.token !== BRIDGE_TOKEN || !BRIDGE_TOKEN) {
      return;
    }

    const { requestId, action, payload } = event.data;
    if (event.data.type !== "api-request" || !["transcribe-single", "upload-media-source", "extract-existing-sources", "delete-sources"].includes(action)) {
      return;
    }

    const progress = (stage, detail = {}) => {
      sendToContent("api-progress", requestId, {
        stage,
        scope: "api",
        message: stage,
        ...detail
      });
    };

    try {
      const client = new NotebookLmApiClient(progress);
      let result;
      if (action === "transcribe-single" || action === "upload-media-source") {
        const file = payload && payload.file;
        if (!isFileLike(file)) {
          throw new Error("No media file was provided to the page API client.");
        }
        result = await client.transcribeSingleFile(file, {
          ...(payload.options || {}),
          requireTranscript: action === "transcribe-single",
          waitForProcessing: action === "transcribe-single"
        });
      } else if (action === "extract-existing-sources") {
        result = await client.extractExistingSources(payload || {});
      } else {
        result = await client.deleteSources(payload || {});
      }
      sendToContent("api-response", requestId, {
        ok: true,
        result
      });
    } catch (error) {
      sendToContent("api-response", requestId, {
        ok: false,
        error: serialize(error)
      });
    }
  }

  class NotebookLmApiClient {
    constructor(progress) {
      this.progress = progress;
      this.params = extractRuntimeParams();
      this.reqid = Math.floor(Math.random() * 900000) + 100000;
      this.lastRpc = "";
    }

    async transcribeSingleFile(file, options) {
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

      this.progress("Starting resumable upload...", {
        sourceId
      });
      const uploadUrl = await this.startUpload(file, fileName, sourceId);

      this.progress("Uploading file bytes...", {
        sourceId
      });
      await this.uploadBytes(uploadUrl, file);

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
      let transcriptPayload = null;
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

    async extractExistingSources(options = {}) {
      this.progress("正在读取笔记本来源列表…", {
        lastRpc: RPC.pollNotebook
      });
      const notebookPayload = await this.getNotebookState();
      const allSources = extractSourceRecords(notebookPayload, this.params.projectId);
      const requestedIds = new Set(Array.isArray(options.sourceIds) ? options.sourceIds.filter(Boolean) : []);
      const skippedIds = new Set(Array.isArray(options.skipSourceIds) ? options.skipSourceIds.filter(Boolean) : []);
      const sourceNames = options.sourceNames && typeof options.sourceNames === "object" ? options.sourceNames : {};
      const waitForReady = options.waitForReady === true;
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15 * 60 * 1000;
      const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 3000;
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

      const records = [];
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
            await this.waitForSourceReady(source.sourceId, timeoutMs, pollIntervalMs, sourceName);
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

    async deleteSources(options = {}) {
      this.progress("正在读取待移除来源…", {
        lastRpc: RPC.pollNotebook
      });
      const notebookPayload = await this.getNotebookState();
      const allSources = extractSourceRecords(notebookPayload, this.params.projectId);
      const sourceById = new Map(allSources.map((source) => [source.sourceId, source]));
      const requestedIds = Array.isArray(options.sourceIds)
        ? Array.from(new Set(options.sourceIds.filter(Boolean)))
        : [];
      const targets = requestedIds.length
        ? requestedIds.map((sourceId) => sourceById.get(sourceId) || { sourceId, sourceName: sourceId })
        : allSources;
      const deleted = [];
      const failed = [];

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

    async startUpload(file, fileName, sourceId) {
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
      let lastSource = null;
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

      const rpcPayload = extractRpcPayload(text, rpcid);
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
    const at = firstMatch(runtimeText, /AABr[a-zA-Z0-9_\-:.]+/);
    const bl = firstMatch(runtimeText, /boq_labs-tailwind-frontend_[0-9A-Za-z_.-]+/) ||
      extractQueryParamFromRuntimeText(runtimeText, "bl");
    const fsid = extractQueryParamFromRuntimeText(runtimeText, "f.sid") ||
      firstMatch(runtimeText, /f\.sid[=:"'\s]+(-?\d{8,})/) ||
      firstMatch(runtimeText, /"f\.sid","(-?\d{8,})"/);
    const authuserCandidate = new URLSearchParams(window.location.search).get("authuser") ||
      extractQueryParamFromRuntimeText(runtimeText, "authuser") || "0";
    const authuser = /^\d+$/.test(authuserCandidate) ? authuserCandidate : "0";
    const hl = (document.documentElement.lang || navigator.language || "en-GB").replace("_", "-");

    const missing = [];
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

  function sourceOptions() {
    return [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]];
  }

  function parseBatchexecuteChunks(text) {
    const lines = String(text || "").split("\n");
    const chunks = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index].trim();
      if (!line || line === ")]}'") {
        index += 1;
        continue;
      }
      if (/^\d+$/.test(line) && index + 1 < lines.length) {
        const payload = lines[index + 1];
        parseChunkLine(payload, chunks);
        index += 2;
        continue;
      }
      if (line.startsWith("[") || line.startsWith("{")) {
        parseChunkLine(line, chunks);
      }
      index += 1;
    }
    return chunks;
  }

  function parseChunkLine(line, chunks) {
    try {
      chunks.push(JSON.parse(line));
    } catch (error) {
      sendLog("parser", "warn", "Could not parse batchexecute chunk.", {
        error: error.message,
        preview: String(line || "").slice(0, 300)
      });
    }
  }

  function extractRpcPayload(text, rpcid) {
    const chunks = parseBatchexecuteChunks(text);
    for (const chunk of chunks) {
      if (!Array.isArray(chunk)) {
        continue;
      }
      for (const row of chunk) {
        if (Array.isArray(row) && row[0] === "wrb.fr" && row[1] === rpcid) {
          try {
            return JSON.parse(row[2]);
          } catch (error) {
            throw new Error(`Could not parse ${rpcid} payload: ${error.message}`);
          }
        }
      }
    }
    const error = new Error(`No wrb.fr payload found for ${rpcid}.`);
    error.debug = {
      rpcid,
      chunks: summarizePayload(chunks),
      responsePreview: String(text || "").slice(0, 1500)
    };
    throw error;
  }

  function findSourceEntry(notebookPayload, sourceId) {
    return findSourceArray(notebookPayload, sourceId);
  }

  function findSourceArray(node, sourceId) {
    if (!Array.isArray(node)) return null;
    // rLM1Ne currently encodes one source as
    // [[sourceId], sourceName, sourceMetadata, ...].  Do not stop at the
    // nested [sourceId] tuple: we need its parent row to retain the name and
    // processing state.
    if (Array.isArray(node[0]) && node[0].includes(sourceId) && node.some((item) => typeof item === "string")) {
      return node;
    }
    for (const item of node) {
      const match = findSourceArray(item, sourceId);
      if (match) return match;
    }
    return null;
  }

  function extractSourceRecords(notebookPayload, projectId) {
    const ids = Array.from(new Set(
      (safeStringify(notebookPayload).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])
        .filter((id) => id !== projectId)
    ));
    const visibleNames = extractVisibleSourceNames();
    const records = [];
    const seenEntries = new Set();

    for (const sourceId of ids) {
      const entry = findSourceEntry(notebookPayload, sourceId);
      if (!entry) continue;
      const entryKey = safeStringify(entry);
      if (seenEntries.has(entryKey)) continue;
      const status = summarizeSourceStatus(entry);
      const inferredName = extractSourceName(entry, sourceId, projectId);
      if (!status.ready && !looksLikeSourceName(inferredName)) continue;
      seenEntries.add(entryKey);
      records.push({ sourceId, sourceName: inferredName });
    }

    return records.map((record, index) => ({
      ...record,
      sourceName: visibleNames[index] || record.sourceName || `来源 ${index + 1}`
    }));
  }

  function extractVisibleSourceNames() {
    const blacklist = new Set(["More", "Select all", "Add sources", "Collapse source panel"]);
    return Array.from(document.querySelectorAll("button"))
      .map((button) => (button.getAttribute("aria-label") || button.textContent || "").trim())
      .filter((name) => name && !blacklist.has(name))
      .filter((name) => /(?:https?;|https?:\/\/|www\.|\.(?:mp3|mp4|m4a|wav|pdf|docx?|txt|csv|pptx?|xlsx?))$/i.test(name));
  }

  function extractSourceName(entry, sourceId, projectId) {
    const strings = [];
    collectStrings(entry, strings);
    const candidates = strings
      .map((value) => String(value || "").trim())
      .filter((value) => value && value !== sourceId && value !== projectId)
      .filter((value) => value.length <= 512)
      .filter((value) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
      .filter((value) => !/^(video|audio)\/[a-z0-9.+-]+$/i.test(value));
    candidates.sort((left, right) => scoreSourceName(right) - scoreSourceName(left));
    return candidates[0] || "";
  }

  function collectStrings(node, output) {
    if (typeof node === "string") {
      output.push(node);
      return;
    }
    if (!Array.isArray(node)) return;
    for (const item of node) collectStrings(item, output);
  }

  function scoreSourceName(value) {
    let score = 0;
    if (/(?:mp3|mp4|m4a|wav|pdf|docx?|txt|csv|pptx?|xlsx?)$/i.test(value)) score += 100;
    if (/^(?:https?;|https?:\/\/|www\.)/i.test(value)) score += 80;
    if (/\.[a-z0-9]{2,5}(?:[?#].*)?$/i.test(value)) score += 30;
    if (/\s/.test(value)) score += 8;
    return score;
  }

  function looksLikeSourceName(value) {
    return scoreSourceName(value) >= 30;
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

  function summarizeSourceStatus(source) {
    const text = JSON.stringify(source);
    const mime = firstMatch(text, /(?:video|audio)\/[a-zA-Z0-9.+-]+/);
    const uuidCount = (text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).length;
    const stateCode = directSourceStateCode(source);
    const metaCodes = collectTupleCodes(source, 1);
    const failed = stateCode === 3;
    const metaCode = metaCodes.includes(1) ? 1 : metaCodes[0] ?? null;
    const ready = stateCode === 2 || (stateCode === null && Boolean(mime && uuidCount > 1 && metaCode === 1));
    return {
      ready,
      failed,
      stateCode,
      metaCode,
      mime: mime || null,
      hasBlobId: uuidCount > 1
    };
  }

  function directSourceStateCode(source) {
    if (!Array.isArray(source)) return null;
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const item = source[index];
      if (Array.isArray(item) && item[0] === null && typeof item[1] === "number" && [1, 2, 3, 5].includes(item[1])) {
        return item[1];
      }
    }
    return null;
  }

  function findArrayContainingText(node, needle) {
    if (!needle || !Array.isArray(node)) {
      return null;
    }
    if (node.some((item) => item === needle)) {
      return node;
    }
    for (const item of node) {
      const match = findArrayContainingText(item, needle);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function collectTupleCodes(node, firstValue, output = []) {
    if (!Array.isArray(node)) {
      return output;
    }
    if (node.length >= 2 && node[0] === firstValue && typeof node[1] === "number") {
      output.push(node[1]);
    }
    for (const item of node) {
      collectTupleCodes(item, firstValue, output);
    }
    return output;
  }

  function extractTranscriptText(payload, context) {
    const segments = [];
    collectTimedStrings(payload, false, segments);

    const cleaned = collapseConsecutiveDuplicates(segments)
      .map((text) => cleanTranscriptLine(text))
      .filter(Boolean)
      .filter((text) => isTranscriptLine(text, context));

    return cleaned.join("\n").trim();
  }

  function collectTimedStrings(node, inTimedSegment, output) {
    if (typeof node === "string") {
      if (inTimedSegment) {
        output.push(node);
      }
      return;
    }

    if (!Array.isArray(node)) {
      return;
    }

    const nextTimed = inTimedSegment ||
      (typeof node[0] === "number" && typeof node[1] === "number" && Array.isArray(node[2]));

    for (const child of node) {
      collectTimedStrings(child, nextTimed, output);
    }
  }

  function cleanTranscriptLine(text) {
    return String(text || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
  }

  function isTranscriptLine(text, context) {
    if (!text) return false;
    if (text === context.sourceId || text === context.projectId) return false;
    if (context.fileName && text === context.fileName) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return false;
    if (/^(video|audio)\/[a-z0-9.+-]+$/i.test(text)) return false;
    return true;
  }

  function firstUuid(text, excluded) {
    const matches = String(text || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
    return matches.find((match) => match !== excluded) || "";
  }

  function firstMatch(text, regex) {
    const match = String(text || "").match(regex);
    return match ? match[1] || match[0] : "";
  }

  function collapseConsecutiveDuplicates(items) {
    const output = [];
    let previous = null;
    for (const item of items) {
      if (item !== previous) {
        output.push(item);
      }
      previous = item;
    }
    return output;
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function summarizePayload(payload) {
    const text = safeStringify(payload);
    return {
      type: Array.isArray(payload) ? "array" : typeof payload,
      length: Array.isArray(payload) ? payload.length : undefined,
      preview: text.length > 1200 ? `${text.slice(0, 1200)}...` : text
    };
  }

  function sendToContent(type, requestId, payload) {
    window.postMessage({
      source: APP_ID,
      target: "content",
      type,
      token: BRIDGE_TOKEN,
      requestId,
      payload
    }, window.location.origin);
  }

  function sendLog(scope, level, detail, explicitDetail) {
    window.postMessage({
      source: APP_ID,
      target: "content",
      type: "page-log",
      token: BRIDGE_TOKEN,
      payload: {
        scope,
        level,
        message: messageFromDetail(detail),
        detail: explicitDetail === undefined ? serialize(detail) : explicitDetail,
        time: new Date().toISOString()
      }
    }, window.location.origin);
  }

  function messageFromDetail(detail) {
    if (typeof detail === "string") {
      return detail;
    }
    if (Array.isArray(detail)) {
      return detail.map((item) => {
        if (typeof item === "string") return item;
        if (item instanceof Error) return item.message;
        return safeStringify(item);
      }).join(" ");
    }
    if (detail && detail.kind) {
      const method = detail.request && detail.request.method ? detail.request.method : "";
      const url = detail.request && detail.request.url ? detail.request.url : "";
      const status = detail.response && detail.response.status ? ` ${detail.response.status}` : "";
      return `${detail.kind} ${method} ${url}${status}`.trim();
    }
    return safeStringify(detail);
  }

  function normalizeFetchRequest(args) {
    const [input, init] = args;
    const request = {
      method: "GET",
      url: "",
      headers: {},
      body: null
    };

    if (typeof input === "string" || input instanceof URL) {
      request.url = String(input);
    } else if (input && typeof input === "object") {
      request.url = input.url || "";
      request.method = input.method || "GET";
      request.headers = headersToObject(input.headers);
    }

    if (init && typeof init === "object") {
      request.method = init.method || request.method;
      request.headers = {
        ...request.headers,
        ...headersToObject(init.headers)
      };
      request.body = summarizeBody(init.body);
    }

    request.headers = redactHeaders(request.headers);
    return request;
  }

  function headersToObject(headers) {
    const output = {};
    if (!headers) {
      return output;
    }
    try {
      if (headers instanceof Headers) {
        headers.forEach((value, key) => {
          output[key] = value;
        });
      } else if (Array.isArray(headers)) {
        headers.forEach(([key, value]) => {
          output[key] = value;
        });
      } else {
        Object.assign(output, headers);
      }
    } catch (_error) {
      return { value: "[unreadable headers]" };
    }
    return output;
  }

  function redactHeaders(headers) {
    return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key, redactHeader(key, value)]));
  }

  function redactHeader(name, value) {
    const key = String(name || "").toLowerCase();
    if (key.includes("authorization") || key.includes("cookie") || key.includes("token") || key.includes("secret")) {
      return "[redacted]";
    }
    return String(value);
  }

  function summarizeBody(body) {
    if (!body) return null;
    if (typeof body === "string") {
      return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}...` : body;
    }
    if (body instanceof URLSearchParams) {
      const text = body.toString();
      return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}...` : text;
    }
    if (body instanceof FormData) return "[FormData]";
    if (body instanceof Blob) return `[Blob ${body.type || "unknown"} ${body.size} bytes]`;
    if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength} bytes]`;
    return Object.prototype.toString.call(body);
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
})();
