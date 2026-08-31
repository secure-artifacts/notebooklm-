import type { FacebookDownloadTask } from "@/lib/colabProvider";
import type { TranscriptRecord } from "./domain";

export type FacebookJobStatus = "paused" | "running" | "completed";

export type FacebookBulkJob = {
  version: 1;
  notebookId: string;
  createdAt: number;
  updatedAt: number;
  status: FacebookJobStatus;
  tasks: FacebookDownloadTask[];
  nextIndex: number;
  activeBatchStart: number;
  activeSourceIds: string[];
  records: TranscriptRecord[];
  autoDelete: boolean;
  translate: boolean;
  autoRegister: boolean;
  lastError?: string;
};

export type FacebookJobProgress = Pick<FacebookBulkJob,
  "notebookId" | "status" | "nextIndex" | "activeBatchStart" | "activeSourceIds" |
  "autoDelete" | "translate" | "autoRegister" | "lastError"
> & { records: TranscriptRecord[] };
