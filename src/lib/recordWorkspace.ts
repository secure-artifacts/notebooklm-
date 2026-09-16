import type { TranscriptRecord } from "@/types/domain";
import type { FacebookBulkJob } from "@/types/facebookJob";
import { extractDriveFileId } from "./driveImport";
import { normalizeFacebookUrl } from "./colabProvider";
import { stripSourceSuffix } from "./aiTranslation";

export const MAX_ROWS = 1000;
export type RowRequirements = { translate: boolean; autoRegister: boolean; databaseUrl: string; autoDelete: boolean };
export type RecordRow = TranscriptRecord & {
  rowId: string; displayId: string; url: string;
  provider: "drive" | "facebook" | "existing" | "";
  locked: boolean; phase: "pending" | "working" | "done" | "failed";
  translationPhase: "pending" | "working" | "done" | "failed";
  note: string; registeredKey?: string;
  requirements?: RowRequirements; taskDone?: boolean; registeredTarget?: string;
};
export type Workspace = {
  version: 1; notebookId: string; revision: number; rows: RecordRow[]; widths: number[];
  lease?: { tabId: number; until: number };
};
export type WorkspaceChange = Pick<Workspace, "revision" | "widths" | "lease"> & { upserts: RecordRow[]; deleted: string[] };
export function mergeWorkspaceChange(state: Workspace, change: WorkspaceChange): Workspace {
  const updates = new Map(change.upserts.map((row) => [row.rowId, row]));
  const deleted = new Set(change.deleted), existing = new Set(state.rows.map((r) => r.rowId));
  return { ...state, revision: change.revision, widths: change.widths, lease: change.lease,
    rows: [...state.rows.filter((r) => !deleted.has(r.rowId)).map((r) => updates.get(r.rowId) || r),
      ...change.upserts.filter((r) => !existing.has(r.rowId))] };
}
export type WorkspaceCommand =
  | { type: "add"; rows: RecordRow[] }
  | { type: "edit"; cells: { rowId: string; field: "displayId" | "url"; value: string }[]; additions?: RecordRow[] }
  | { type: "result"; rowId: string; patch: Partial<RecordRow>; automaticId?: string }
  | { type: "delete"; rowIds: string[] }
  | { type: "widths"; widths: number[] }
  | { type: "claim" | "release" | "heartbeat" };
export function providerForUrl(value: string): RecordRow["provider"] {
  return extractDriveFileId(value) ? "drive" : normalizeFacebookUrl(value) ? "facebook" : "";
}
export function newRow(id = "", url = "", rowId: string = crypto.randomUUID()): RecordRow {
  return { rowId, displayId: id.trim(), url: url.trim(), provider: providerForUrl(url.trim()),
    sourceId: "", sourceName: "", transcript: "", locked: false, phase: "pending", translationPhase: "pending", note: "" };
}
export function sheetTarget(value: string): string {
  try { const u = new URL(value); return `${u.pathname.match(/\/d\/([^/]+)/)?.[1] || ""}:${u.searchParams.get("gid") || new URLSearchParams(u.hash.slice(1)).get("gid") || ""}`; } catch { return value; }
}
export async function registrationKey(row: RecordRow, target = ""): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([sheetTarget(target), row.displayId, row.transcript, row.translation || ""]));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function rowComplete(row: RecordRow, translate: boolean): boolean {
  return Boolean(row.transcript && !row.error && (!translate || row.translation));
}
export function requirementsFor(row: RecordRow): RowRequirements {
  return row.requirements || { translate: Boolean(row.translation || row.translationError || row.translationPhase === "working"),
    autoRegister: Boolean(row.registrationError), databaseUrl: "", autoDelete: false };
}
export function taskComplete(row: RecordRow): boolean {
  const req = requirementsFor(row);
  return rowComplete(row, req.translate) && !row.registrationError && (!req.autoRegister || Boolean(row.registeredKey && row.registeredTarget === sheetTarget(req.databaseUrl)));
}
export function needsMedia(row: RecordRow): boolean {
  return !row.transcript || Boolean(row.error) || Boolean(requirementsFor(row).translate && !row.translation && (!row.sourceId || row.sourceDeleted));
}
export function shouldContinue(row: RecordRow): boolean {
  if (row.taskDone) return false;
  if (!row.requirements && taskComplete(row)) return false;
  return row.phase !== "failed" && row.translationPhase !== "failed" && !row.registrationError;
}
export function isUnstartedColabFailure(row: RecordRow): boolean {
  return row.provider === "facebook" && row.phase === "failed" && !row.sourceId && !row.transcript && !row.translation
    && /^未启动 Colab 临时后端[。.]/.test(row.error || "");
}
export function retryRequirements(row: RecordRow, current: RowRequirements): RowRequirements {
  const previous = requirementsFor(row);
  return { ...current, translate: previous.translate || current.translate, autoRegister: previous.autoRegister || current.autoRegister,
    databaseUrl: current.autoRegister ? current.databaseUrl : previous.databaseUrl || current.databaseUrl };
}
export function rowIssue(row: RecordRow): string {
  if (row.provider === "existing") return "";
  return !row.url.trim() ? "请填写视频链接" : !providerForUrl(row.url) ? "仅支持公开的 Google Drive / Facebook HTTPS 链接" : "";
}
export function emptyWorkspace(notebookId: string): Workspace {
  return { version: 1, notebookId, revision: 0, rows: [], widths: [145, 280, 260, 260] };
}
export function applyWorkspaceCommand(state: Workspace, command: WorkspaceCommand, tabId: number, now = Date.now()): Workspace {
  const next = structuredClone(state);
  if (next.lease && next.lease.until <= now) delete next.lease;
  if (next.lease && next.lease.tabId !== tabId) throw new Error("此笔记本正在另一个标签页处理，请先在该标签页暂停。");
  if (command.type === "claim") next.lease = { tabId, until: now + 90_000 };
  else if (command.type === "heartbeat") {
    if (next.lease?.tabId !== tabId) throw new Error("队列运行权已失效，请刷新后继续。");
    next.lease.until = now + 90_000;
  } else if (command.type === "release") delete next.lease;
  else if (command.type === "add") {
    if (next.rows.length + command.rows.length > MAX_ROWS) throw new Error(`表格最多 ${MAX_ROWS} 行`);
    for (const row of command.rows) {
      if (!row.rowId || next.rows.some((item) => item.rowId === row.rowId)) throw new Error("记录编号重复");
      next.rows.push(structuredClone(row));
    }
  } else if (command.type === "edit") {
    if (next.lease) throw new Error("请先暂停，再编辑记录。");
    if (next.rows.length + (command.additions?.length || 0) > MAX_ROWS) throw new Error(`表格最多 ${MAX_ROWS} 行`);
    for (const row of command.additions || []) {
      if (!row.rowId || next.rows.some((r) => r.rowId === row.rowId)) throw new Error("记录编号重复");
      next.rows.push(structuredClone(row));
    }
    for (const cell of command.cells) {
      const row = next.rows.find((item) => item.rowId === cell.rowId);
      if (!row) throw new Error("该行已被删除，请刷新表格。");
      if (row.locked) throw new Error("该行已开始导入，ID 和链接已锁定。请删除该行后重新添加。");
      if (cell.field === "displayId") row.displayId = cell.value.trim();
      else { row.url = cell.value.trim(); row.provider = providerForUrl(row.url); }
      row.note = ""; row.error = ""; row.phase = "pending";
    }
  } else if (command.type === "result") {
    const row = next.rows.find((item) => item.rowId === command.rowId);
    if (!row) throw new Error("结果对应的行已被删除");
    const { rowId: _rowId, displayId: _id, url: _url, ...patch } = command.patch;
    const wasLocked = row.locked && !(isUnstartedColabFailure(row) && patch.phase === "pending" && patch.error === "");
    Object.assign(row, patch);
    row.locked ||= wasLocked;
    if (!row.displayId && command.automaticId) row.displayId = command.automaticId;
  } else if (command.type === "delete") {
    if (next.lease) throw new Error("请先暂停，再删除记录。");
    const ids = new Set(command.rowIds); next.rows = next.rows.filter((row) => !ids.has(row.rowId));
  } else if (command.type === "widths") {
    if (command.widths.length !== 4) throw new Error("列宽数量无效");
    next.widths = command.widths.map((value) => Math.max(90, Math.min(1200, Number(value) || 160)));
  }
  next.revision++; return next;
}
export function migrateLegacyJob(notebookId: string, job: FacebookBulkJob | null): Workspace {
  const state = emptyWorkspace(notebookId); if (!job) return state;
  const unused = [...job.records];
  for (const [index, task] of job.tasks.entries()) {
    const found = unused.findIndex((record) => stripSourceSuffix(record.sourceName) === stripSourceSuffix(task.postId));
    const record = found >= 0 ? unused.splice(found, 1)[0] : undefined;
    const row = newRow(task.postId, task.url);
    if (record) Object.assign(row, record);
    row.locked = Boolean(record || index < job.nextIndex);
    row.phase = row.transcript ? "done" : row.error ? "failed" : "pending";
    row.translationPhase = row.translation ? "done" : row.translationError ? "failed" : "pending";
    if (!record && index >= job.activeBatchStart && job.activeSourceIds.length) {
      row.note = "旧队列中断，请先提取现有来源核对后重试，避免重复上传。"; row.phase = "failed";
    }
    state.rows.push(row);
  }
  for (const record of unused) {
    const row = newRow(stripSourceSuffix(record.sourceName));
    Object.assign(row, record, { provider: "existing", locked: true, phase: record.transcript ? "done" : "failed",
      translationPhase: record.translation ? "done" : "pending" }); state.rows.push(row);
  }
  return state;
}
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  const source = text.replace(/\r\n/g, "\n");
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"' && (quoted || !cell)) {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (c === "\t" || c === "\n")) {
      row.push(cell); cell = ""; if (c === "\n") { rows.push(row); row = []; }
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); } return rows;
}
export function serializeTsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => /[\t\r\n"]/.test(cell)
    ? `"${cell.replace(/"/g, '""')}"` : cell).join("\t")).join("\n");
}
