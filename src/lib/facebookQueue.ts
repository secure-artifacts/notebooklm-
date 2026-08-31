import type { FacebookDownloadTask } from "./colabProvider";
import type { FacebookBulkJob } from "@/types/facebookJob";

export const FACEBOOK_MAX_TASKS = 1000;
export const FACEBOOK_BATCH_SIZE = 20;
export const NOTEBOOK_SOURCE_LIMIT = 50;
export const RESULT_RENDER_LIMIT = 50;

export function createFacebookJob(
  notebookId: string,
  tasks: FacebookDownloadTask[],
  options: { autoDelete: boolean; translate: boolean; autoRegister: boolean },
  now = Date.now()
): FacebookBulkJob {
  if (!notebookId) throw new Error("缺少 NotebookLM 笔记本编号。");
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > FACEBOOK_MAX_TASKS) {
    throw new Error(`Facebook 队列必须包含 1 到 ${FACEBOOK_MAX_TASKS} 条任务。`);
  }
  return {
    version: 1,
    notebookId,
    createdAt: now,
    updatedAt: now,
    status: "paused",
    tasks: tasks.map((task) => ({ ...task })),
    nextIndex: 0,
    activeBatchStart: 0,
    activeSourceIds: [],
    records: [],
    autoDelete: options.autoDelete,
    translate: options.translate,
    autoRegister: options.autoRegister
  };
}

export function facebookTaskFingerprint(tasks: FacebookDownloadTask[]): string {
  return JSON.stringify(tasks.map((task) => [task.postId, task.url]));
}

export function removeFacebookJobTasks(job: FacebookBulkJob, taskIds: Set<string>, now = Date.now()): FacebookBulkJob {
  if (!taskIds.size) return { ...job };
  const removedIndexes: number[] = [];
  const tasks = job.tasks.filter((task, index) => {
    const remove = taskIds.has(task.taskId);
    if (remove) removedIndexes.push(index);
    return !remove;
  });
  const removedBeforeNext = removedIndexes.filter((index) => index < job.nextIndex).length;
  const removedBeforeActive = removedIndexes.filter((index) => index < job.activeBatchStart).length;
  const nextIndex = Math.min(tasks.length, Math.max(0, job.nextIndex - removedBeforeNext));
  const activeBatchStart = Math.min(tasks.length, Math.max(0, job.activeBatchStart - removedBeforeActive));
  return {
    ...job,
    tasks,
    nextIndex,
    activeBatchStart,
    status: nextIndex >= tasks.length ? "completed" : "paused",
    lastError: nextIndex >= tasks.length ? undefined : job.lastError,
    updatedAt: now
  };
}

export function nextFacebookBatch(
  job: FacebookBulkJob,
  currentSourceCount: number,
  batchSize = FACEBOOK_BATCH_SIZE
): FacebookDownloadTask[] {
  const available = Math.max(0, NOTEBOOK_SOURCE_LIMIT - Math.max(0, Math.floor(currentSourceCount)));
  const remaining = job.tasks.length - job.nextIndex;
  const size = Math.min(Math.max(0, batchSize), available, remaining);
  return size ? job.tasks.slice(job.nextIndex, job.nextIndex + size) : [];
}

export function retainedSourceCapacity(currentSourceCount: number): number {
  return Math.max(0, NOTEBOOK_SOURCE_LIMIT - Math.max(0, Math.floor(currentSourceCount)));
}

export function formatFacebookTasks(tasks: FacebookDownloadTask[]): string {
  return tasks.map((task) => `${task.postId} ${task.url}`).join("\n");
}
