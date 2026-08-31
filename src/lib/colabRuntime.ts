export const COLAB_START_TIMEOUT_MS = 90_000;
export const COLAB_RUNTIME_STALE_MS = 45_000;

export type ColabRuntimeState = "stopped" | "starting" | "ready" | "stale" | "failed";

export type ColabRuntimeSnapshot = {
  tabId: number;
  sessionId: string;
  state: ColabRuntimeState;
  startedAt: number;
  lastSeenAt: number;
  error?: string;
};

export function isValidColabSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{12,100}$/u.test(value);
}

export function isColabStartupExpired(snapshot: ColabRuntimeSnapshot, now = Date.now()): boolean {
  return snapshot.state === "starting" && now - snapshot.startedAt >= COLAB_START_TIMEOUT_MS;
}

export function isColabRuntimeStale(snapshot: ColabRuntimeSnapshot, now = Date.now()): boolean {
  return snapshot.state === "ready" && now - snapshot.lastSeenAt >= COLAB_RUNTIME_STALE_MS;
}

export function runtimeStateLabel(state: ColabRuntimeState): string {
  if (state === "starting") return "启动中";
  if (state === "ready") return "已就绪";
  if (state === "stale") return "连接已失效";
  if (state === "failed") return "启动失败";
  return "未启动";
}
