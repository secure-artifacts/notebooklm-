import { normalizeGradioControlUrl, parseGradioSseData } from "@/lib/colabProvider";
import type { ColabApiName, ColabApiRequest } from "@/types/messages";

const allowedApis = new Set<ColabApiName>([
  "health",
  "start_batch",
  "provide_upload",
  "poll_events",
  "cancel_batch",
  "shutdown"
]);
const CONTROL_TIMEOUT_MS = 45_000;
const MAX_REQUEST_CHARS = 512_000;
const CONTROL_CONNECT_ATTEMPTS = 6;
const CONTROL_CONNECT_TIMEOUT_MS = 15_000;
const RETRYABLE_CONTROL_STATUSES = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

type ColabControlOptions = {
  connectAttempts?: number;
  connectTimeoutMs?: number;
  resultAttempts?: number;
  resultTimeoutMs?: number;
};

export async function callColabControl(request: ColabApiRequest, options: ColabControlOptions = {}): Promise<unknown> {
  const baseUrl = normalizeGradioControlUrl(request.baseUrl);
  if (!baseUrl) throw new Error("Colab 控制地址无效。");
  if (!allowedApis.has(request.apiName)) throw new Error("不支持的 Colab 控制操作。");
  if (typeof request.token !== "string" || request.token.length < 32) throw new Error("Colab 会话令牌无效。");
  if (!Array.isArray(request.data)) throw new Error("Colab 控制参数无效。");

  const data = [...request.data, request.token];
  const body = JSON.stringify({ data });
  if (body.length > MAX_REQUEST_CHARS) throw new Error("Colab 控制请求过大，请减少单批任务数量。");

  const startResponse = await startControlCall(
    baseUrl,
    request.apiName,
    body,
    options.connectAttempts ?? CONTROL_CONNECT_ATTEMPTS,
    options.connectTimeoutMs ?? CONTROL_CONNECT_TIMEOUT_MS
  );
  if (!startResponse.ok) throw new Error(`Colab 控制请求失败（HTTP ${startResponse.status}）。`);

  const startPayload = await startResponse.json() as { event_id?: string };
  const eventId = String(startPayload.event_id || "").trim();
  if (!/^[A-Za-z0-9_-]{8,}$/u.test(eventId)) throw new Error("Colab 控制端未返回有效事件编号。");

  const resultResponse = await fetchWithRetry(
    `${baseUrl}/gradio_api/call/${request.apiName}/${encodeURIComponent(eventId)}`,
    {
      method: "GET",
      headers: controlHeaders(baseUrl, { Accept: "text/event-stream" })
    },
    options.resultAttempts ?? 3,
    options.resultTimeoutMs ?? CONTROL_TIMEOUT_MS
  );
  if (!resultResponse.ok) throw new Error(`Colab 控制结果读取失败（HTTP ${resultResponse.status}）。`);
  const values = parseGradioSseData(await resultResponse.text());
  if (!values.length) throw new Error("Colab 控制端没有返回结果。");
  return values.length === 1 ? values[0] : values;
}

async function startControlCall(
  baseUrl: string,
  apiName: ColabApiName,
  body: string,
  attempts: number,
  timeoutMs: number
): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown = null;
  const paths = [
    `/gradio_api/call/v2/${apiName}`,
    `/gradio_api/call/${apiName}`
  ];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const path of paths) {
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: controlHeaders(baseUrl, { "Content-Type": "application/json" }),
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (response.ok) return response;
        lastResponse = response;
        if (!RETRYABLE_CONTROL_STATUSES.has(response.status)) return response;
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt + 1 < attempts) await wait(Math.min(750 * (attempt + 1), 3_000));
  }

  if (lastResponse) return lastResponse;
  throw new Error(`Colab 临时控制通道暂时无法连接：${errorMessage(lastError)}`);
}

function controlHeaders(baseUrl: string, headers: Record<string, string>): Record<string, string> {
  if (new URL(baseUrl).hostname.endsWith(".loca.lt")) {
    return { ...headers, "bypass-tunnel-reminder": "true" };
  }
  return headers;
}

async function fetchWithRetry(url: string, init: RequestInit, attempts: number, timeoutMs: number): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.ok || !RETRYABLE_CONTROL_STATUSES.has(response.status)) return response;
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await wait(750 * (attempt + 1));
  }
  if (lastResponse) return lastResponse;
  throw new Error(`Colab 控制结果暂时无法读取：${errorMessage(lastError)}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "连接超时";
  if (error instanceof Error && error.message && error.message !== "Failed to fetch") return error.message;
  return "网络尚未就绪";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
