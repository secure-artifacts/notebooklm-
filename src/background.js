"use strict";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;
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

