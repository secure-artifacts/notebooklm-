"use strict";

const GOOGLE_TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const MAX_CHUNK_CHARS = 1800;
const REQUEST_DELAY_MS = 650;
const MAX_ATTEMPTS = 3;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;
  if (message.type === "translate-burmese-to-chinese") {
    translateBurmeseToChinese(String(message.text || ""))
      .then((translation) => sendResponse({ ok: true, translation }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message.type === "sheet-upsert") {
    upsertSheetRecords(message.deploymentUrl, message.databaseUrl, message.records)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: {
          code: error.code || "REQUEST_FAILED",
          message: error.message || String(error),
          http_status: error.httpStatus || 0,
          response_preview: error.responsePreview || ""
        }
      }));
    return true;
  }
});

async function upsertSheetRecords(deploymentUrl, databaseUrl, records) {
  const url = new URL(String(deploymentUrl || ""));
  if (url.protocol !== "https:") throw new Error("The deployment URL must use HTTPS.");
  url.searchParams.set("action", "upsert");
  if (!Array.isArray(records) || !records.length) throw new Error("No transcript records are available.");

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ database_url: databaseUrl, records })
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    const error = new Error(`表格服务返回的不是 JSON（HTTP ${response.status}）。`);
    error.code = "NON_JSON_RESPONSE";
    error.httpStatus = response.status;
    error.responsePreview = text.slice(0, 300);
    throw error;
  }
  return payload;
}

async function translateBurmeseToChinese(text) {
  if (!text.trim()) return "";
  const chunks = splitText(text, MAX_CHUNK_CHARS);
  const translations = [];

  for (let index = 0; index < chunks.length; index += 1) {
    if (index) await wait(REQUEST_DELAY_MS);
    translations.push(await translateChunk(chunks[index]));
  }
  return translations.join("").trim();
}

async function translateChunk(text) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const url = new URL(GOOGLE_TRANSLATE_ENDPOINT);
      url.searchParams.set("client", "gtx");
      url.searchParams.set("sl", "my");
      url.searchParams.set("tl", "zh-CN");
      url.searchParams.set("dt", "t");
      url.searchParams.set("q", text);

      const response = await fetch(url);
      if (!response.ok) throw new Error(`Google 翻译请求失败（HTTP ${response.status}）。`);
      const payload = await response.json();
      const translation = Array.isArray(payload && payload[0])
        ? payload[0].map((segment) => Array.isArray(segment) ? segment[0] : "").join("")
        : "";
      if (!translation) throw new Error("Google 翻译未返回文本。");
      return translation;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await wait(REQUEST_DELAY_MS * attempt);
    }
  }
  throw lastError || new Error("Google 翻译失败。");
}

function splitText(text, maxLength) {
  const chunks = [];
  let remaining = String(text || "");
  while (remaining.length > maxLength) {
    const windowText = remaining.slice(0, maxLength + 1);
    const boundary = Math.max(
      windowText.lastIndexOf("။"),
      windowText.lastIndexOf("\n"),
      windowText.lastIndexOf("。"),
      windowText.lastIndexOf("！"),
      windowText.lastIndexOf("？"),
      windowText.lastIndexOf(". ")
    );
    const end = boundary > maxLength * 0.45 ? boundary + 1 : maxLength;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
