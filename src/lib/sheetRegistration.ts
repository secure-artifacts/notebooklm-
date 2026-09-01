import type { SheetRecord } from "@/types/messages";
import type { TranscriptRecord } from "@/types/domain";

export type FailureLog = { title: string; message: string };
export type StatusCounts = Record<string, number>;

export const SHEET_REGISTRATION_MAX_RECORDS = 200;
export const SHEET_REGISTRATION_SAFE_PAYLOAD_BYTES = 1_500_000;

export function parseStatusCount(value: unknown, fallback = 0): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : fallback;
}

export function addStatusCount(target: StatusCounts, status: string, count: unknown): void {
  const amount = parseStatusCount(count);
  if (!status || !amount) return;
  target[status] = (target[status] || 0) + amount;
}

export function mergeStatusCounts(target: StatusCounts, incoming: unknown): void {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return;
  Object.entries(incoming).forEach(([status, count]) => addStatusCount(target, status, count));
}

export function formatStatusCounts(statusCounts: StatusCounts): string {
  return `status_counts\n${JSON.stringify(statusCounts || {}, null, 2)}`;
}

export function validDeploymentUrl(value: unknown): boolean {
  return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:[?#].*)?$/i.test(String(value || ""));
}

export function validDatabaseUrl(value: unknown): boolean {
  return /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+\/edit.*(?:[#?&]gid=\d+)/i.test(String(value || ""));
}

export function toSheetRecords(
  records: TranscriptRecord[],
  sourceNameToPostId: (value: string) => string = (value) => String(value || "")
): SheetRecord[] {
  return (Array.isArray(records) ? records : []).map((record) => ({
    post_id: sourceNameToPostId(record.sourceName),
    audio_content: record.transcript,
    audio_content_zh: record.translation || ""
  }));
}

export function sheetRegistrationPayloadBytes(databaseUrl: string, records: SheetRecord[]): number {
  return new TextEncoder().encode(JSON.stringify({
    database_url: String(databaseUrl || ""),
    records: Array.isArray(records) ? records : []
  })).byteLength;
}

export function chunkSheetRegistrationRecords(
  records: SheetRecord[],
  databaseUrl: string,
  options: { maxRecords?: number; maxPayloadBytes?: number } = {}
): SheetRecord[][] {
  const maxRecords = Math.max(1, Math.floor(options.maxRecords || SHEET_REGISTRATION_MAX_RECORDS));
  const maxPayloadBytes = Math.max(1024, Math.floor(options.maxPayloadBytes || SHEET_REGISTRATION_SAFE_PAYLOAD_BYTES));
  const batches: SheetRecord[][] = [];
  let current: SheetRecord[] = [];

  for (const record of Array.isArray(records) ? records : []) {
    const candidate = [...current, record];
    if (current.length && (candidate.length > maxRecords ||
      sheetRegistrationPayloadBytes(databaseUrl, candidate) > maxPayloadBytes)) {
      batches.push(current);
      current = [record];
    } else {
      current = candidate;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

export function isSheetRequestTooLarge(value: unknown): boolean {
  const candidate = value as {
    http_status?: unknown;
    httpStatus?: unknown;
    error?: { code?: unknown; message?: unknown };
    code?: unknown;
    message?: unknown;
  } | null;
  const status = Number(candidate?.http_status ?? candidate?.httpStatus);
  const code = String(candidate?.error?.code ?? candidate?.code ?? "").toUpperCase();
  const message = String(candidate?.error?.message ?? candidate?.message ?? value ?? "");
  return status === 413 || code === "REQUEST_TOO_LARGE" || /HTTP\s*413|REQUEST_TOO_LARGE|请求体超过\s*2\s*MB|request entity too large/i.test(message);
}

export function summarizeSheetPostIds(records: SheetRecord[], limit = 12): string {
  const postIds = (Array.isArray(records) ? records : []).map((record) => String(record.post_id || "未命名"));
  const visible = postIds.slice(0, Math.max(1, Math.floor(limit)));
  const remaining = postIds.length - visible.length;
  return `${visible.join("、")}${remaining > 0 ? `；另有 ${remaining} 条` : ""}`;
}

type ServiceOutcome = {
  success?: boolean;
  index?: number;
  post_id?: string;
  error?: { code?: string; message?: string };
};

type ServiceResult = {
  ok?: boolean;
  error?: { code?: string; message?: string };
  http_status?: number | string;
  request_id?: string;
  data?: {
    summary?: { success?: number; failed?: number; status_counts?: StatusCounts };
    results?: ServiceOutcome[];
  };
};

export function analyzeBatchResponse(
  result: ServiceResult | null | undefined,
  batchRecords: SheetRecord[],
  options: { batchStart?: number; batchLabel?: string } = {}
) {
  const records = Array.isArray(batchRecords) ? batchRecords : [];
  const batchLabel = options.batchLabel || "";
  const batchStart = Number.isFinite(options.batchStart) ? options.batchStart! : 0;
  const statusCounts: StatusCounts = Object.create(null);
  const failureLogs: FailureLog[] = [];

  if (!result || result.ok !== true) {
    const apiError = result?.error || {};
    const status = result?.http_status || "未知";
    const requestId = result?.request_id || "无";
    addStatusCount(statusCounts, "request_failed", records.length);
    failureLogs.push({
      title: `批次 ${batchLabel} 请求失败`,
      message: [
        `HTTP ${status} · request_id: ${requestId}`,
        `${apiError.code || "UNKNOWN"}：${apiError.message || "服务未返回具体原因"}`,
        `未登记 post_id：${summarizeSheetPostIds(records)}`
      ].join("\n")
    });
    return { success: 0, failed: records.length, statusCounts, failureLogs, requestFailed: true };
  }

  const summary = result.data?.summary || {};
  const outcomes = Array.isArray(result.data?.results) ? result.data!.results! : [];
  mergeStatusCounts(statusCounts, summary.status_counts);
  const outcomeSuccess = outcomes.filter((outcome) => outcome?.success === true).length;
  const outcomeFailed = outcomes.filter((outcome) => outcome?.success === false).length;
  let success = Math.min(records.length, parseStatusCount(summary.success, outcomeSuccess));
  let failed = Math.min(records.length - success, parseStatusCount(summary.failed, outcomeFailed));

  const unaccounted = records.length - success - failed;
  if (unaccounted > 0) {
    failed += unaccounted;
    addStatusCount(statusCounts, "unreported_result", unaccounted);
    const reportedIndexes = new Set(outcomes.map((outcome) => Number(outcome?.index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < records.length));
    const missingRecords = records.filter((_record, index) => !reportedIndexes.has(index));
    failureLogs.push({
      title: `批次 ${batchLabel} 返回不完整`,
      message: `服务未返回 ${unaccounted} 条记录的结果。未确认 post_id：${summarizeSheetPostIds(missingRecords) || "无法确定"}`
    });
  }

  outcomes.filter((outcome) => outcome?.success === false).forEach((outcome) => {
    const localIndex = Number(outcome.index);
    const original = Number.isInteger(localIndex) ? records[localIndex] : null;
    const postId = outcome.post_id || original?.post_id ||
      `总第 ${batchStart + (Number.isInteger(localIndex) ? localIndex : 0) + 1} 条`;
    const error = outcome.error || {};
    const code = error.code ? ` [${error.code}]` : "";
    failureLogs.push({
      title: "失败",
      message: `${postId}${code}：${error.message || "处理失败（服务未返回具体原因）"}`
    });
  });

  return { success, failed, statusCounts, failureLogs, requestFailed: false };
}
