import { newRow, rowComplete, rowIssue, registrationKey, requirementsFor, retryRequirements, needsMedia, shouldContinue, taskComplete, sheetTarget, isUnstartedColabFailure, type RecordRow } from "@/lib/recordWorkspace";
import { stripSourceSuffix } from "@/lib/aiTranslation";
import { chunkSheetRegistrationRecords, analyzeBatchResponse, isSheetRequestTooLarge, validDatabaseUrl, validDeploymentUrl } from "@/lib/sheetRegistration";
import { mapConcurrent, formatBytes } from "@/lib/driveImport";
import { WorkspaceClient } from "./workspaceClient";
import { DriveDownloadClient } from "./driveDownloadClient";
import { FacebookImportCoordinator, ColabNotStartedError } from "./facebookCoordinator";
import { callNotebookPageApi } from "./notebookClient";
import { extensionClient } from "./extensionClient";
import { translateBatch, TranslationPaused } from "./translationService";
import type { TranscriptRecord } from "@/types/domain";
import type { SheetRecord } from "@/types/messages";

export type PipelineOptions = { translate: boolean; translationBatch: number; batchSize: number; autoDelete: boolean; autoRegister: boolean; databaseUrl: string };
export class WorkspacePipeline {
  busy = false; paused = false;
  private drive = new DriveDownloadClient();
  private heartbeat = 0;
  private translate = translateBatch;
  constructor(readonly store: WorkspaceClient, readonly panel: HTMLElement,
    readonly report: (message: string, error?: boolean) => void, readonly render: () => void) {}
  pause() { this.paused = true; this.report("已请求暂停，当前请求完成并保存后停止。"); }
  private guard() {
    if (location.pathname.replace(/\/$/, "") !== `/notebook/${this.store.notebookId}`) throw new Error("已切换笔记本，任务已暂停；请回到原笔记本继续。");
  }
  private patch(id: string, patch: Partial<RecordRow>, automaticId?: string) {
    return this.store.command({ type: "result", rowId: id, patch, automaticId });
  }
  private async api(action, payload = {}, timeout = 1_800_000): Promise<any> {
    this.guard(); return callNotebookPageApi(action, payload, () => undefined, timeout);
  }
  async execute(work: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true; this.paused = false; this.render();
    let claimed = false;
    try {
    this.guard(); await this.store.command({ type: "claim" }); claimed = true;
    this.heartbeat = window.setInterval(() => {
      void this.store.command({ type: "heartbeat" }).catch((error) => { this.paused = true; this.report(error.message, true); });
    }, 25_000);
    await work(); this.report(this.paused ? "已暂停，记录已保存。点击继续可恢复。" : "处理完成，记录已保存。"); }
    catch (error) { this.paused = true; this.report(error.message || String(error), !(error instanceof TranslationPaused)); }
    finally {
      clearInterval(this.heartbeat);
      try { if (claimed) await this.store.command({ type: "release" }); } catch (error) { this.report(`释放队列失败：${error.message}`, true); }
      this.busy = false; this.render();
    }
  }
  async validateRegistration(url: string) {
    const settings = await extensionClient.getSettings();
    if (!validDatabaseUrl(url) || !validDeploymentUrl(settings.deploymentUrl)) throw new Error("请填写含 gid 的登记表格链接，并在扩展图标中配置 Apps Script /exec 部署链接。");
  }
  async run(options: PipelineOptions, retryIds?: string[]) {
    await this.execute(async () => {
      for (const row of this.store.state.rows) if (isUnstartedColabFailure(row)) {
        await this.patch(row.rowId, { phase: "pending", error: "", note: "", locked: false, requirements: undefined, taskDone: false });
      }
      const ids = this.store.state.rows.filter((r) => retryIds ? retryIds.includes(r.rowId) : shouldContinue(r)).map((r) => r.rowId);
      if (!ids.length) { this.report("没有待处理记录；失败或历史记录请勾选后点击重试选中。"); return; }
      const registrationTargets = new Set<string>();
      for (const id of ids) {
        const row = this.store.row(id);
        const requirements = retryIds ? retryRequirements(row, options) : row.requirements || { ...options };
        if (requirements.autoRegister) registrationTargets.add(requirements.databaseUrl);
      }
      for (const target of registrationTargets) await this.validateRegistration(target);
      for (const id of ids) { const issue = rowIssue(this.store.row(id)); if (issue) throw new Error(`${this.store.row(id).displayId || "未命名行"}：${issue}`); }
      for (const id of ids) {
        const row = this.store.row(id);
        await this.patch(id, { requirements: retryIds ? retryRequirements(row, options) : row.requirements || { ...options }, taskDone: false });
      }
      const summary = await this.api("get-source-summary", {}, 60_000);
      const newCount = ids.filter((id) => { const r = this.store.row(id); return needsMedia(r) && (!r.sourceId || r.sourceDeleted); }).length;
      if (ids.every((id) => !requirementsFor(this.store.row(id)).autoDelete) && newCount > Math.max(0, 50 - summary.totalSources)) throw new Error(`自动移除已关闭，当前只能再导入 ${Math.max(0, 50 - summary.totalSources)} 个来源，请减少输入。`);
      // Resume persisted transcripts first, so retained sources do not consume new capacity.
      await this.finish(ids.filter((id) => !needsMedia(this.store.row(id))), options);
      for (let offset = 0; offset < ids.length && !this.paused;) {
        this.guard();
        const todo = ids.slice(offset).filter((id) => needsMedia(this.store.row(id)));
        if (!todo.length) break;
        const first = this.store.row(todo[0]);
        const current = await this.api("get-source-summary", {}, 60_000);
        let slots = Math.max(0, 50 - current.totalSources);
        const batch: string[] = [];
        for (const id of todo) {
          const row = this.store.row(id);
          if (batch.length >= options.batchSize || row.provider !== first.provider) break;
          const needsUpload = !row.sourceId || row.sourceDeleted;
          if (needsUpload && slots <= 0) break;
          batch.push(id); if (needsUpload) slots--;
        }
        if (!batch.length) throw new Error("NotebookLM 来源名额不足；请处理失败来源或删除来源后继续。");
        this.report(`正在处理 ${batch.length} 条 ${first.provider === "drive" ? "Drive" : "Facebook"} 记录`);
        const existing = batch.filter((id) => this.store.row(id).sourceId && !this.store.row(id).sourceDeleted);
        for (const id of existing) { if (this.paused) break; await this.extractRow(id); }
        const fresh = batch.filter((id) => !existing.includes(id));
        if (fresh.some((id) => this.store.row(id).provider === "existing")) throw new Error("选中来源已不存在且没有下载链接，请重新添加链接；已有正文仍保留。");
        if (!this.paused && first.provider === "facebook" && fresh.length) await this.facebook(fresh);
        else if (!this.paused) await mapConcurrent(fresh, 3, async (id) => { if (!this.paused) await this.driveRow(id); });
        await this.finish(batch, options);
        offset = ids.indexOf(batch[batch.length - 1]) + 1;
      }
    });
  }
  private async extracted(id: string, record: TranscriptRecord) {
    await this.patch(id, { sourceId: record.sourceId || this.store.row(id).sourceId,
      sourceName: record.sourceName || this.store.row(id).sourceName,
      sourceOriginalName: record.sourceOriginalName || record.sourceName || this.store.row(id).sourceOriginalName,
      transcript: this.store.row(id).transcript || record.transcript || "", error: record.error || "", sourceDeleted: record.sourceDeleted ?? this.store.row(id).sourceDeleted,
      phase: record.transcript && !record.error ? "done" : "failed", note: "" },
      stripSourceSuffix(record.sourceOriginalName || record.sourceName));
  }
  private async extractRow(id: string) {
    const row = this.store.row(id);
    await this.patch(id, { locked: true, phase: "working", error: "", note: "等待 NotebookLM 转录" });
    try {
      const result = await this.api("extract-existing-sources", { sourceIds: [row.sourceId], sourceNames: { [row.sourceId]: row.sourceOriginalName || row.sourceName }, waitForReady: true, timeoutMs: 1_770_000, overallTimeoutMs: 1_770_000 });
      await this.extracted(id, result.records?.[0] || { sourceId: row.sourceId, sourceName: row.sourceName, transcript: "", error: "未返回转录" });
    } catch (error) { await this.patch(id, { phase: "failed", error: error.message, note: "" }); }
  }
  private async driveRow(id: string) {
    let row = this.store.row(id);
    await this.patch(id, { locked: true, phase: "working", error: "", note: "下载中" });
    try {
      const file = await this.drive.download(row.url, (bytes) => this.report(`Drive 下载：${formatBytes(bytes)}`));
      this.guard();
      const name = row.displayId ? `${row.displayId.replace(/[\\/:*?"<>|]/g, "_")}.${file.name.split(".").pop() || "mp4"}` : file.name;
      await this.patch(id, { sourceName: name, sourceOriginalName: name, note: "正在上传" }, stripSourceSuffix(file.name));
      const upload = await this.api("upload-media-source", { file: new File([file], name, { type: file.type }), options: { timeoutMs: 1_770_000 } });
      await this.patch(id, { sourceId: upload.sourceId, sourceDeleted: false, note: "等待转录" });
      await this.extractRow(id);
    } catch (error) { await this.patch(id, { phase: "failed", error: error.message, note: "" }); }
  }
  private async facebook(ids: string[]) {
    const tasks = ids.map((id) => { const r = this.store.row(id); return { taskId: id, postId: r.displayId || `video_${id.replace(/-/g, "").slice(0, 12)}`, autoId: !r.displayId, url: r.url }; });
    const coordinator = new FacebookImportCoordinator({
      onBatchAccepted: async () => {
        for (const id of ids) await this.patch(id, { locked: true, phase: "working", error: "", note: "下载中" });
      },
      beforeNotebookRequest: () => this.guard(),
      onStage: (text) => this.report(text), onLog: (text) => this.report(text),
      onSourcePrepared: async (sourceId, id, name) => {
        this.guard(); await this.patch(id, { sourceId, sourceName: name, sourceOriginalName: name, sourceDeleted: false, note: "等待转录" }, stripSourceSuffix(name));
      },
      onRecord: (id, record) => this.extracted(id, record)
    });
    try {
      const records = await coordinator.start(tasks, false);
      for (let i = 0; i < records.length; i++) await this.extracted(ids[i], records[i]);
    } catch (error) {
      if (error instanceof ColabNotStartedError) {
        for (const id of ids) {
          const row = this.store.row(id);
          await this.patch(id, { phase: row.transcript ? "done" : "pending", error: "", note: "", requirements: row.locked ? row.requirements : undefined });
        }
        throw error;
      }
      for (const id of ids) if (!this.store.row(id).transcript) await this.patch(id, { phase: "failed", error: error.message, note: "" });
      throw error;
    }
  }
  private async finish(ids: string[], options: PipelineOptions) {
    if (!this.paused) {
      const pending = ids.filter((id) => { const r = this.store.row(id); return requirementsFor(r).translate && r.transcript && !r.error && !r.translation; });
      for (let start = 0; start < pending.length && !this.paused; start += options.translationBatch) {
        const batch = pending.slice(start, start + options.translationBatch);
        for (const id of batch) {
          if (this.store.row(id).sourceDeleted) throw new Error("待翻译来源已被移除，需要重新导入。原文仍保留。");
          await this.patch(id, { translationPhase: "working", translationError: "" });
        }
        this.report(`正在翻译 ${start + 1}–${start + batch.length}/${pending.length} 条`);
        try {
          const result = await this.translate(batch.map((id) => this.store.row(id)), this.panel, () => this.paused,
            async (id, translation) => { await this.patch(id, { translation, translationPhase: "done", translationError: "" }); }, {
              stage: (text) => this.report(text),
              request: async (ids, request) => { for (const id of ids) await this.patch(id, { translationRequest: request }); }
            });
          for (const id of batch) await this.patch(id, result.has(id)
            ? { translation: result.get(id), translationPhase: "done", translationError: "" }
            : this.paused ? { translationPhase: "pending", translationError: "" }
            : { translationPhase: "failed", translationError: "未返回该来源的完整中文翻译，来源已保留。" });
          if (batch.some((id) => !this.store.row(id).translation)) this.paused = true;
        } catch (error) {
          for (const id of batch) if (!this.store.row(id).translation) await this.patch(id, error instanceof TranslationPaused
            ? { translationPhase: "pending", translationError: "" } : { translationPhase: "failed", translationError: error.message });
          throw error;
        }
      }
    }
    if (this.paused) return;
    const completed = ids.filter((id) => { const r = this.store.row(id); return rowComplete(r, requirementsFor(r).translate); });
    const targets = new Set(completed.map((id) => requirementsFor(this.store.row(id))).filter((r) => r.autoRegister).map((r) => r.databaseUrl));
    for (const target of targets) await this.registerRows(completed.filter((id) => { const r = requirementsFor(this.store.row(id)); return r.autoRegister && r.databaseUrl === target; }), target, true);
    if (this.paused) return;
    {
      for (const id of completed) {
        if (this.paused) return;
        const r = this.store.row(id); if (!taskComplete(r) || !requirementsFor(r).autoDelete || !r.sourceId || r.sourceDeleted) continue;
        // Persistence above must succeed before source deletion is allowed.
        const result = await this.api("delete-sources", { sourceIds: [r.sourceId], deleteAll: false }, 60_000);
        const deleted = (result.deleted || []).includes(r.sourceId);
        await this.patch(id, { sourceDeleted: deleted, note: deleted ? "" : "自动移除失败，来源仍保留" });
      }
    }
    for (const id of completed) {
      const row = this.store.row(id);
      if (taskComplete(row) && (!requirementsFor(row).autoDelete || !row.sourceId || row.sourceDeleted)) await this.patch(id, { taskDone: true });
    }
  }
  async extractExisting(options: PipelineOptions) {
    await this.execute(async () => {
      if (options.autoRegister) await this.validateRegistration(options.databaseUrl);
      const result = await this.api("extract-existing-sources", { skipSourceIds: this.store.state.rows.filter((r) => r.transcript).map((r) => r.sourceId) });
      const ids: string[] = [];
      for (const record of result.records || []) {
        let row = this.store.state.rows.find((r) => r.sourceId === record.sourceId);
        if (!row) {
          row = newRow(stripSourceSuffix(record.sourceName)); row.provider = "existing"; row.locked = true;
          await this.store.command({ type: "add", rows: [row] });
        }
        await this.patch(row.rowId, { requirements: row.requirements || { ...options }, taskDone: false });
        await this.extracted(row.rowId, record); ids.push(row.rowId);
      }
      for (const row of this.store.state.rows) if (!ids.includes(row.rowId) && shouldContinue(row) && !needsMedia(row)) ids.push(row.rowId);
      await this.finish(ids, options);
    });
  }
  async registerRows(ids: string[], url: string, onlyChanged = false) {
    await this.validateRegistration(url);
    const rows = ids.map((id) => this.store.row(id)).filter((r) => r.transcript && !r.error);
    if (!onlyChanged) for (const row of rows) await this.patch(row.rowId, { requirements: { ...requirementsFor(row), autoRegister: true, databaseUrl: url }, taskDone: false });
    if (rows.some((r) => !r.displayId)) throw new Error("存在空 ID，无法登记。");
    if (new Set(rows.map((r) => r.displayId)).size !== rows.length) throw new Error("存在重复 ID，登记可能覆盖记录，请先核对表格。");
    const snapshots = (await Promise.all(rows.map(async (r) => ({ rowId: r.rowId, key: await registrationKey(r, url), data: { post_id: r.displayId, audio_content: r.transcript, audio_content_zh: r.translation || "" } }))))
      .filter((s) => !onlyChanged || this.store.row(s.rowId).registeredKey !== s.key || Boolean(this.store.row(s.rowId).registrationError));
    const batches = chunkSheetRegistrationRecords(snapshots.map((s) => s.data), url);
    for (const batch of batches) {
      if (this.paused) break;
      const current = batch.map((data) => snapshots.find((s) => s.data === data)!);
      await this.sendRegistration(current, url);
    }
  }
  private async sendRegistration(items: { rowId: string; key: string; data: SheetRecord }[], url: string): Promise<void> {
    if (!items.length) return;
    let result: any;
    try {
      result = await extensionClient.upsertSheet({ databaseUrl: url, records: items.map((s) => s.data) });
      if (isSheetRequestTooLarge(result)) throw new Error("REQUEST_TOO_LARGE");
    } catch (error) {
      if (isSheetRequestTooLarge(error) && items.length > 1) {
        const mid = Math.ceil(items.length / 2); await this.sendRegistration(items.slice(0, mid), url); await this.sendRegistration(items.slice(mid), url); return;
      }
      for (const item of items) await this.patch(item.rowId, { registrationError: error.message });
      throw error;
    }
    const analysis = analyzeBatchResponse(result, items.map((i) => i.data));
    const outcomes = result?.data?.results || [];
    for (const [index, item] of items.entries()) {
      const outcome = outcomes.find((r) => r.index === index || r.post_id === item.data.post_id);
      const success = outcome ? outcome.success === true : analysis.failed === 0;
      await this.patch(item.rowId, success ? { registeredKey: item.key, registeredTarget: sheetTarget(url), registered: true, registrationError: "" }
        : { registrationError: outcome?.error?.message || "登记失败或服务未确认该行，请重试。" });
    }
    this.report(`登记成功 ${analysis.success}，失败 ${analysis.failed}`, analysis.failed > 0);
    if (analysis.failed > 0) throw new Error("部分记录未确认登记成功，队列已暂停，来源保留；请检查 ID 单元格备注后重试。");
  }
  async deleteSources() {
    await this.execute(async () => {
      const result = await this.api("delete-sources", { sourceIds: [], deleteAll: true }, 600_000);
      const deleted = new Set(result.deleted || []);
      for (const row of this.store.state.rows) if (deleted.has(row.sourceId)) await this.patch(row.rowId, { sourceDeleted: true });
      if (result.failed?.length) throw new Error(`${result.failed.length} 个来源未能删除。`);
    });
  }
  dispose() { this.paused = true; this.drive.dispose(); }
}
