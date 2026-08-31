import {
  decodeColabControlValue,
  parseColabControlEvents,
  type ColabBridgeEvent,
  type FacebookDownloadTask
} from "@/lib/colabProvider";
import type { TranscriptRecord } from "@/types/domain";
import { extensionClient } from "./extensionClient";
import { callNotebookPageApi } from "./notebookClient";

const SESSION_TIMEOUT_MS = 90 * 60 * 1000;
const NOTEBOOK_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 1200;

type CoordinatorHooks = {
  onStage: (message: string) => void;
  onLog: (message: string, kind: string) => void;
  onSourcePrepared?: (sourceId: string) => Promise<void> | void;
  onTaskStatus?: (taskId: string, status: string, message?: string) => void;
};

type RuntimeTask = {
  input: FacebookDownloadTask;
  sourceId?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  extraction?: Promise<TranscriptRecord>;
  failure?: TranscriptRecord;
};

type ControlEvent = Extract<ColabBridgeEvent, { type: "control" }>;

export class FacebookImportCoordinator {
  private hooks: CoordinatorHooks;
  private cancelled = false;
  private baseUrl = "";
  private token = "";
  private pendingSourceIds = new Set<string>();

  constructor(hooks: CoordinatorHooks) {
    this.hooks = hooks;
  }

  async start(tasks: FacebookDownloadTask[], autoDelete: boolean): Promise<TranscriptRecord[]> {
    if (!tasks.length) return [];
    this.cancelled = false;
    const runtimes = new Map(tasks.map((task) => [task.taskId, { input: task } as RuntimeTask]));
    let control: ControlEvent | null = null;
    try {
      control = decodeColabControlValue(await extensionClient.findReusableColabRuntime()) as ControlEvent | null;
    } catch {
      control = null;
    }
    if (!control) {
      throw new Error("未启动 Colab 临时后端。请点击浏览器扩展图标，先启动 Colab 临时后端并等待其显示已就绪。");
    }
    this.hooks.onStage("正在连接 Colab 临时后端…");
    this.hooks.onLog("已连接当前浏览器中的唯一 Colab 临时后端。", "Colab");
    this.baseUrl = control.base_url;
    this.token = control.token;

    let accepted: any;
    try {
      accepted = decodeColabControlValue(await this.callControl("start_batch", [JSON.stringify(tasks)]));
    } catch (error) {
      throw new Error(`Colab 临时后端连接失败，请点击扩展图标重新启动后端。${errorMessage(error)}`);
    }
    if (!accepted?.ok) throw new Error(`Colab 拒绝任务：${String(accepted?.error || "未知原因")}`);

    let cursor = Math.max(0, Number(accepted.cursor) || 0);
    let complete = false;
    let pollFailures = 0;
    const deadline = Date.now() + SESSION_TIMEOUT_MS;
    while (!complete && !this.cancelled && Date.now() < deadline) {
      try {
        const events = parseColabControlEvents(await this.callControl("poll_events", [cursor]));
        pollFailures = 0;
        for (const event of events) cursor = Math.max(cursor, Number((event as any).sequence) || 0);
        if (this.cancelled) break;

        for (const event of events) {
          if (event.type === "task" && event.status === "downloaded") {
            this.hooks.onTaskStatus?.(event.task_id, "downloaded");
            await this.prepareUpload(runtimes, event);
          }
        }
        for (const event of events) {
          if (event.type === "task" && event.status === "uploading") {
            this.hooks.onTaskStatus?.(event.task_id, "uploading");
            this.hooks.onStage(`Colab 正在直传：${runtimes.get(event.task_id)?.input.postId || event.task_id}`);
          } else if (event.type === "task" && event.status === "uploaded") {
            this.hooks.onTaskStatus?.(event.task_id, "processing");
            this.startExtraction(runtimes, event, autoDelete);
          } else if (event.type === "task" && event.status === "failed") {
            this.hooks.onTaskStatus?.(event.task_id, "failed", event.error);
            await this.recordFailure(runtimes, event);
          } else if (event.type === "complete") {
            complete = true;
          } else if (event.type === "fatal") {
            throw new Error(event.message);
          }
        }
      } catch (error) {
        pollFailures += 1;
        if (pollFailures >= 3) throw error;
        this.hooks.onLog(`Colab 控制请求暂时失败，正在重试（${pollFailures}/3）。`, "自动重试");
      }
      if (!complete) await wait(POLL_INTERVAL_MS);
    }

    if (this.cancelled) throw new Error("Facebook 导入已取消。");
    if (!complete) throw new Error("Facebook 导入超过最长运行时间。");
    const records = await Promise.all(Array.from(runtimes.values()).map(async (runtime) => {
      if (runtime.extraction) return runtime.extraction;
      if (runtime.failure) return runtime.failure;
      return failureRecord(runtime, "Colab 未返回该任务的最终状态。");
    }));
    this.dispose();
    return records;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.baseUrl && this.token) {
      try {
        await this.callControl("cancel_batch", []);
      } catch {
        // Cancellation is best effort; local orchestration still stops.
      }
    }
    await Promise.all(Array.from(this.pendingSourceIds, (sourceId) => deleteSourceQuietly(sourceId)));
    this.pendingSourceIds.clear();
    this.dispose();
  }

  private async callControl(apiName: "start_batch" | "provide_upload" | "poll_events" | "cancel_batch", data: unknown[]): Promise<unknown> {
    return extensionClient.callColab({ baseUrl: this.baseUrl, token: this.token, apiName, data });
  }

  private async prepareUpload(runtimes: Map<string, RuntimeTask>, event: Extract<ColabBridgeEvent, { type: "task" }>): Promise<void> {
    const runtime = runtimes.get(event.task_id);
    if (!runtime || runtime.sourceId || runtime.failure) return;
    const fileName = String(event.file_name || `${runtime.input.postId}.mp4`);
    const mimeType = String(event.mime_type || "");
    const size = Number(event.size);
    this.hooks.onStage(`正在申请上传会话：${runtime.input.postId}`);
    try {
      const prepared = await callNotebookPageApi("prepare-remote-media-source", {
        fileName,
        type: mimeType,
        size
      }, () => undefined, 60_000);
      runtime.sourceId = String(prepared.sourceId || "");
      if (!runtime.sourceId) throw new Error("NotebookLM 未返回来源编号。");
      this.pendingSourceIds.add(runtime.sourceId);
      await this.hooks.onSourcePrepared?.(runtime.sourceId);
      runtime.fileName = fileName;
      runtime.mimeType = mimeType;
      runtime.size = size;
      await this.callControl("provide_upload", [JSON.stringify({
        taskId: runtime.input.taskId,
        sourceId: runtime.sourceId,
        uploadUrl: prepared.uploadUrl
      })]);
      // Do not retain the signed upload URL in extension state.
      prepared.uploadUrl = "";
    } catch (error) {
      if (runtime.sourceId) await deleteSourceQuietly(runtime.sourceId);
      if (runtime.sourceId) this.pendingSourceIds.delete(runtime.sourceId);
      runtime.failure = failureRecord(runtime, errorMessage(error));
      try {
        await this.callControl("provide_upload", [JSON.stringify({
          taskId: runtime.input.taskId,
          error: runtime.failure.error
        })]);
      } catch {
        // The control channel may be the primary failure; Colab has its own timeout.
      }
      this.hooks.onLog(`${runtime.input.postId}：${runtime.failure.error}`, "上传会话失败");
    }
  }

  private startExtraction(runtimes: Map<string, RuntimeTask>, event: Extract<ColabBridgeEvent, { type: "task" }>, autoDelete: boolean): void {
    const runtime = runtimes.get(event.task_id);
    if (!runtime || runtime.extraction || runtime.failure || !runtime.sourceId) return;
    const sourceId = runtime.sourceId;
    runtime.extraction = (async () => {
      this.hooks.onStage(`等待 NotebookLM 转录：${runtime.input.postId}`);
      try {
        const result = await callNotebookPageApi("extract-existing-sources", {
          sourceIds: [sourceId],
          sourceNames: { [sourceId]: runtime.fileName || runtime.input.postId },
          waitForReady: true,
          timeoutMs: NOTEBOOK_PROCESSING_TIMEOUT_MS,
          overallTimeoutMs: NOTEBOOK_PROCESSING_TIMEOUT_MS
        }, () => undefined, NOTEBOOK_PROCESSING_TIMEOUT_MS + 30_000);
        const record = Array.isArray(result.records) ? result.records[0] : null;
        if (!record?.transcript || record.error) throw new Error(record?.error || "NotebookLM 未返回转录文字。");
        if (autoDelete) {
          await deleteSourceQuietly(sourceId);
          record.sourceDeleted = true;
        }
        this.pendingSourceIds.delete(sourceId);
        this.hooks.onTaskStatus?.(runtime.input.taskId, "completed");
        return record as TranscriptRecord;
      } catch (error) {
        if (autoDelete) await deleteSourceQuietly(sourceId);
        this.pendingSourceIds.delete(sourceId);
        this.hooks.onTaskStatus?.(runtime.input.taskId, "failed", errorMessage(error));
        return failureRecord(runtime, errorMessage(error));
      }
    })();
  }

  private async recordFailure(runtimes: Map<string, RuntimeTask>, event: Extract<ColabBridgeEvent, { type: "task" }>): Promise<void> {
    const runtime = runtimes.get(event.task_id);
    if (!runtime || runtime.failure || runtime.extraction) return;
    if (runtime.sourceId) await deleteSourceQuietly(runtime.sourceId);
    if (runtime.sourceId) this.pendingSourceIds.delete(runtime.sourceId);
    runtime.failure = failureRecord(runtime, String(event.error || "Colab 任务失败。"));
    this.hooks.onLog(`${runtime.input.postId}：${runtime.failure.error}`, "Colab 失败");
  }

  private dispose(): void {
    this.baseUrl = "";
    this.token = "";
  }
}

async function deleteSourceQuietly(sourceId: string): Promise<void> {
  try {
    await callNotebookPageApi("delete-sources", { sourceIds: [sourceId] }, () => undefined, 60_000);
  } catch {
    // The caller reports the primary failure; cleanup remains best effort.
  }
}

function failureRecord(runtime: RuntimeTask, message: string): TranscriptRecord {
  return {
    sourceId: runtime.sourceId || "",
    sourceName: runtime.input.postId,
    sourceOriginalName: runtime.fileName || runtime.input.postId,
    transcript: "",
    error: message
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
