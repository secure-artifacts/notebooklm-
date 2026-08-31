import type { SheetRecord } from "@/types/messages";
import { validDatabaseUrl, validDeploymentUrl } from "@/lib/sheetRegistration";

export type BackgroundSheetUpsertRequest = {
  deploymentUrl: string;
  databaseUrl: string;
  records: SheetRecord[];
};

type RequestError = Error & {
  code?: string;
  httpStatus?: number;
  responsePreview?: string;
};

export async function upsertSheetRecords(request: BackgroundSheetUpsertRequest): Promise<unknown> {
  if (!validDeploymentUrl(request.deploymentUrl)) {
    throw new Error("The Apps Script deployment URL is invalid.");
  }
  if (!validDatabaseUrl(request.databaseUrl)) {
    throw new Error("The Google Sheets URL is invalid or has no gid.");
  }
  if (!Array.isArray(request.records) || !request.records.length) {
    throw new Error("No transcript records are available.");
  }
  if (request.records.length > 200) {
    throw new Error("Each sheet registration batch is limited to 200 records.");
  }

  const url = new URL(String(request.deploymentUrl || ""));
  url.searchParams.set("action", "upsert");

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      database_url: request.databaseUrl,
      records: request.records
    })
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`表格服务返回的不是 JSON（HTTP ${response.status}）。`) as RequestError;
    error.code = "NON_JSON_RESPONSE";
    error.httpStatus = response.status;
    error.responsePreview = text.slice(0, 300);
    throw error;
  }
}
