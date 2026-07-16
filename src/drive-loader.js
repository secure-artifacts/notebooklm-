(function () {
  "use strict";

  const APP_ID = "nlm-video-translation-helper";
  const NOTEBOOKLM_ORIGIN = "https://notebooklm.google.com";
  const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
  const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba"]);
  const VIDEO_EXTENSIONS = new Set(["3gp", "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm"]);
  const MIME_BY_EXTENSION = {
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    wav: "audio/wav",
    weba: "audio/webm",
    "3gp": "video/3gpp",
    avi: "video/x-msvideo",
    m4v: "video/mp4",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    mp4: "video/mp4",
    mpeg: "video/mpeg",
    mpg: "video/mpeg",
    ogv: "video/ogg",
    webm: "video/webm"
  };

  const bridgeToken = new URLSearchParams(location.hash.slice(1)).get("token") || "";
  window.addEventListener("message", handleMessage);

  function handleMessage(event) {
    if (event.source !== parent || event.origin !== NOTEBOOKLM_ORIGIN) return;
    const message = event.data;
    if (!message || message.source !== APP_ID || message.target !== "drive-loader" || message.token !== bridgeToken) return;
    if (message.type !== "drive-download-request") return;

    downloadPublicDriveMedia(message.url, message.requestId)
      .then((file) => postResult(message.requestId, { ok: true, file, mediaType: file.type, size: file.size }))
      .catch((error) => postResult(message.requestId, {
        ok: false,
        error: error && error.message ? error.message : String(error)
      }));
  }

  async function downloadPublicDriveMedia(sharedUrl, requestId) {
    const reference = extractDriveReference(sharedUrl);
    if (!reference) throw new Error("不是有效的 Google Drive 文件链接。");
    const { fileId, resourceKey } = reference;

    const downloadUrl = new URL("https://drive.usercontent.google.com/download");
    downloadUrl.searchParams.set("id", fileId);
    downloadUrl.searchParams.set("export", "download");
    downloadUrl.searchParams.set("confirm", "t");
    if (resourceKey) downloadUrl.searchParams.set("resourcekey", resourceKey);

    const response = await fetch(downloadUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "follow",
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error(`Drive 下载失败（HTTP ${response.status}）。请确认文件已公开并允许下载。`);
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_MEDIA_BYTES) throw new Error("文件超过 512 MB，已停止下载以防浏览器内存不足。");

    const contentType = normalizeMimeType(response.headers.get("content-type"));
    if (contentType === "text/html" || contentType === "application/xhtml+xml") {
      throw new Error("Drive 返回了网页而不是文件。请将文件设为“知道链接的任何人可查看”并允许下载。");
    }

    const disposition = response.headers.get("content-disposition") || "";
    const responseName = filenameFromDisposition(disposition);
    const chunks = [];
    let receivedBytes = 0;

    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_MEDIA_BYTES) {
          await reader.cancel();
          throw new Error("文件超过 512 MB，已停止下载以防浏览器内存不足。");
        }
        chunks.push(value);
        postProgress(requestId, receivedBytes, declaredLength);
      }
    } else {
      const buffer = await response.arrayBuffer();
      receivedBytes = buffer.byteLength;
      if (receivedBytes > MAX_MEDIA_BYTES) throw new Error("文件超过 512 MB，已停止下载以防浏览器内存不足。");
      chunks.push(new Uint8Array(buffer));
    }

    if (!receivedBytes) throw new Error("Drive 返回了空文件。");
    const preliminaryBlob = new Blob(chunks, { type: contentType || "application/octet-stream" });
    const detected = await detectMedia(preliminaryBlob, responseName, contentType);
    if (!detected) {
      throw new Error(`文件不是受支持的音频或视频（响应类型：${contentType || "未知"}）。`);
    }

    const fileName = safeFileName(responseName || `${fileId}.${extensionForMime(detected.mimeType)}`);
    return new File(chunks, fileName, { type: detected.mimeType, lastModified: Date.now() });
  }

  async function detectMedia(blob, fileName, declaredType) {
    if (declaredType.startsWith("audio/") || declaredType.startsWith("video/")) {
      return { kind: declaredType.split("/")[0], mimeType: declaredType };
    }

    const extension = extensionFromName(fileName);
    const header = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    const magicType = sniffMagicType(header, extension);
    if (magicType) return { kind: magicType.split("/")[0], mimeType: magicType };
    if (AUDIO_EXTENSIONS.has(extension)) return { kind: "audio", mimeType: MIME_BY_EXTENSION[extension] };
    if (VIDEO_EXTENSIONS.has(extension)) return { kind: "video", mimeType: MIME_BY_EXTENSION[extension] };
    return null;
  }

  function sniffMagicType(bytes, extension) {
    const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
    if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
    if (ascii(0, 4) === "fLaC") return "audio/flac";
    if (ascii(0, 4) === "OggS") return VIDEO_EXTENSIONS.has(extension) ? "video/ogg" : "audio/ogg";
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") return "video/x-msvideo";
    if (ascii(4, 4) === "ftyp") return AUDIO_EXTENSIONS.has(extension) ? "audio/mp4" : "video/mp4";
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return AUDIO_EXTENSIONS.has(extension) ? "audio/webm" : "video/webm";
    }
    return "";
  }

  function extractDriveReference(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:" || !/(^|\.)drive\.google\.com$/i.test(url.hostname)) return null;
      const pathMatch = url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
      const candidate = (pathMatch && pathMatch[1]) || url.searchParams.get("id") || "";
      if (!/^[a-zA-Z0-9_-]{10,}$/.test(candidate)) return null;
      const resourceKeyCandidate = url.searchParams.get("resourcekey") || "";
      const resourceKey = /^[a-zA-Z0-9_-]+$/.test(resourceKeyCandidate) ? resourceKeyCandidate : "";
      return { fileId: candidate, resourceKey };
    } catch (_error) {
      return null;
    }
  }

  function filenameFromDisposition(value) {
    const encoded = String(value || "").match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (encoded) {
      try { return normalizeFileName(decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ""))); } catch (_error) { /* continue */ }
    }
    const quoted = String(value || "").match(/filename\s*=\s*"([^"]+)"/i);
    if (quoted) return normalizeFileName(quoted[1]);
    const plain = String(value || "").match(/filename\s*=\s*([^;]+)/i);
    return plain ? normalizeFileName(plain[1].trim()) : "";
  }

  function normalizeFileName(value) {
    const input = String(value || "").trim();
    const mimeDecoded = decodeMimeEncodedWord(input);
    return repairUtf8Mojibake(mimeDecoded).normalize("NFC");
  }

  function decodeMimeEncodedWord(value) {
    const match = String(value || "").match(/^=\?UTF-8\?([BQ])\?([^?]+)\?=$/i);
    if (!match) return value;
    try {
      let bytes;
      if (match[1].toUpperCase() === "B") {
        const binary = atob(match[2]);
        bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      } else {
        const decoded = match[2].replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_all, hex) =>
          String.fromCharCode(Number.parseInt(hex, 16)));
        bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (_error) {
      return value;
    }
  }

  function repairUtf8Mojibake(value) {
    const input = String(value || "");
    if (!/[\u0080-\u00ff]/.test(input) || Array.from(input).some((character) => character.charCodeAt(0) > 255)) {
      return input;
    }
    try {
      const bytes = Uint8Array.from(input, (character) => character.charCodeAt(0));
      const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return /[\u3400-\u9fff\uf900-\ufaff]/.test(repaired) ? repaired : input;
    } catch (_error) {
      return input;
    }
  }

  function safeFileName(value) {
    const cleaned = String(value || "media-file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
    return cleaned.slice(0, 180) || "media-file";
  }

  function normalizeMimeType(value) {
    return String(value || "").split(";", 1)[0].trim().toLowerCase();
  }

  function extensionFromName(value) {
    const match = String(value || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return match ? match[1] : "";
  }

  function extensionForMime(mimeType) {
    const preferred = {
      "audio/aac": "aac",
      "audio/flac": "flac",
      "audio/mp4": "m4a",
      "audio/mpeg": "mp3",
      "audio/ogg": "ogg",
      "audio/wav": "wav",
      "audio/webm": "weba",
      "video/3gpp": "3gp",
      "video/mp4": "mp4",
      "video/mpeg": "mpeg",
      "video/ogg": "ogv",
      "video/quicktime": "mov",
      "video/webm": "webm",
      "video/x-matroska": "mkv",
      "video/x-msvideo": "avi"
    };
    return preferred[mimeType] || (mimeType.startsWith("video/") ? "mp4" : "mp3");
  }

  function postProgress(requestId, receivedBytes, totalBytes) {
    parent.postMessage({
      source: APP_ID,
      target: "content",
      type: "drive-download-progress",
      token: bridgeToken,
      requestId,
      payload: { receivedBytes, totalBytes }
    }, NOTEBOOKLM_ORIGIN);
  }

  function postResult(requestId, payload) {
    parent.postMessage({
      source: APP_ID,
      target: "content",
      type: "drive-download-response",
      token: bridgeToken,
      requestId,
      payload
    }, NOTEBOOKLM_ORIGIN);
  }
})();
