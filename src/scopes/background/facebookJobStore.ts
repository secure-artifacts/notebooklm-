import { FACEBOOK_MAX_TASKS } from "@/lib/facebookQueue";
import type { FacebookBulkJob, FacebookJobProgress } from "@/types/facebookJob";

const databaseName = "nlmTranscriptJobs";
const jobStoreName = "facebookJobs";
const activityStoreName = "facebookJobActivity";
const databaseVersion = 2;

export async function loadFacebookJob(notebookId: string): Promise<FacebookBulkJob | null> {
  assertNotebookId(notebookId);
  const [job, activity] = await Promise.all([
    runRequest<FacebookBulkJob | undefined>(jobStoreName, "readonly", (store) => store.get(notebookId)),
    runRequest<{ notebookId: string; activeBatchStart: number; activeSourceIds: string[] } | undefined>(
      activityStoreName,
      "readonly",
      (store) => store.get(notebookId)
    )
  ]);
  if (!job) return null;
  return normalizeFacebookJob({
    ...job,
    activeBatchStart: activity?.activeBatchStart ?? job.activeBatchStart,
    activeSourceIds: activity?.activeSourceIds ?? job.activeSourceIds
  });
}

export async function saveFacebookJob(job: FacebookBulkJob): Promise<void> {
  assertFacebookJob(job);
  await runJobAndActivityTransaction((jobStore, activityStore) => {
    const updatedAt = Date.now();
    jobStore.put({ ...job, updatedAt });
    activityStore.put(activityRecord(job.notebookId, job.activeBatchStart, job.activeSourceIds, updatedAt));
  });
}

export async function updateFacebookJobProgress(progress: FacebookJobProgress): Promise<void> {
  assertNotebookId(progress?.notebookId);
  const job = await loadFacebookJob(progress.notebookId);
  if (!job) throw new Error("Facebook 任务检查点不存在。");
  job.status = progress.status;
  job.nextIndex = progress.nextIndex;
  job.activeBatchStart = progress.activeBatchStart;
  job.activeSourceIds = progress.activeSourceIds;
  job.autoDelete = progress.autoDelete;
  job.translate = progress.translate;
  job.autoRegister = progress.autoRegister;
  job.lastError = progress.lastError;
  job.records = mergeRecords(job.records, progress.records);
  await saveFacebookJob(job);
}

export async function clearFacebookJob(notebookId: string): Promise<void> {
  assertNotebookId(notebookId);
  await runJobAndActivityTransaction((jobStore, activityStore) => {
    jobStore.delete(notebookId);
    activityStore.delete(notebookId);
  });
}

export async function updateFacebookJobActiveSources(
  notebookId: string,
  activeBatchStart: number,
  activeSourceIds: string[]
): Promise<void> {
  assertNotebookId(notebookId);
  if (!Number.isInteger(activeBatchStart) || activeBatchStart < 0 || activeBatchStart > FACEBOOK_MAX_TASKS) {
    throw new Error("Facebook 活动批次位置无效。");
  }
  await saveActivity(notebookId, activeBatchStart, activeSourceIds);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(jobStoreName)) database.createObjectStore(jobStoreName, { keyPath: "notebookId" });
      if (!database.objectStoreNames.contains(activityStoreName)) database.createObjectStore(activityStoreName, { keyPath: "notebookId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开 Facebook 任务存储。"));
  });
}

async function runRequest<T = unknown>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error("Facebook 任务存储操作失败。"));
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error("Facebook 任务存储事务已中止。"));
    };
  });
}

function saveActivity(notebookId: string, activeBatchStart: number, activeSourceIds: string[]): Promise<unknown> {
  return runRequest(activityStoreName, "readwrite", (store) => store.put(activityRecord(
    notebookId,
    activeBatchStart,
    activeSourceIds,
    Date.now()
  )));
}

function activityRecord(notebookId: string, activeBatchStart: number, activeSourceIds: string[], updatedAt: number) {
  return {
    notebookId,
    activeBatchStart,
    activeSourceIds: Array.from(new Set(activeSourceIds.filter(Boolean))),
    updatedAt
  };
}

async function runJobAndActivityTransaction(operation: (jobStore: IDBObjectStore, activityStore: IDBObjectStore) => void): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([jobStoreName, activityStoreName], "readwrite");
    try {
      operation(transaction.objectStore(jobStoreName), transaction.objectStore(activityStoreName));
    } catch (error) {
      transaction.abort();
      database.close();
      reject(error);
      return;
    }
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("Facebook 任务检查点事务失败。"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error("Facebook 任务检查点事务已中止。"));
    };
  });
}

function mergeRecords(existing: FacebookBulkJob["records"], incoming: FacebookBulkJob["records"]): FacebookBulkJob["records"] {
  const merged = new Map<string, FacebookBulkJob["records"][number]>();
  existing.forEach((record, index) => merged.set(record.sourceName || record.sourceId || `existing-${index}`, record));
  incoming.forEach((record, index) => merged.set(record.sourceName || record.sourceId || `incoming-${index}`, record));
  return Array.from(merged.values());
}

function assertNotebookId(value: string): void {
  if (!/^[0-9a-f-]{20,80}$/iu.test(String(value || ""))) throw new Error("NotebookLM 笔记本编号无效。");
}

function assertFacebookJob(job: FacebookBulkJob): void {
  assertNotebookId(job?.notebookId);
  if (job?.version !== 1 || !Array.isArray(job.tasks) || job.tasks.length > FACEBOOK_MAX_TASKS) {
    throw new Error("Facebook 任务检查点无效。");
  }
  if (!Number.isInteger(job.nextIndex) || job.nextIndex < 0 || job.nextIndex > job.tasks.length || !Array.isArray(job.records)) {
    throw new Error("Facebook 任务进度无效。");
  }
  if (!Number.isInteger(job.activeBatchStart) || job.activeBatchStart < 0 || job.activeBatchStart > job.tasks.length || !Array.isArray(job.activeSourceIds)) {
    throw new Error("Facebook 活动批次检查点无效。");
  }
}

function normalizeFacebookJob(job: FacebookBulkJob): FacebookBulkJob {
  const normalized = {
    ...job,
    activeBatchStart: Number.isInteger(job.activeBatchStart) ? job.activeBatchStart : job.nextIndex,
    activeSourceIds: Array.isArray(job.activeSourceIds) ? job.activeSourceIds.filter(Boolean) : []
  };
  assertFacebookJob(normalized);
  return normalized;
}
