import type { SheetRecord } from "@/types/messages";
import type { TranscriptRecord } from "@/types/domain";

export type FailureLog = { title: string; message: string };
export type StatusCounts = Record<string, number>;

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
        `未登记 post_id：${records.map((record) => record.post_id).join("、")}`
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
    const missingPostIds = records.filter((_record, index) => !reportedIndexes.has(index)).map((record) => record.post_id);
    failureLogs.push({
      title: `批次 ${batchLabel} 返回不完整`,
      message: `服务未返回 ${unaccounted} 条记录的结果。未确认 post_id：${missingPostIds.join("、") || "无法确定"}`
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
