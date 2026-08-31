export function extractDriveFileId(value: unknown): string {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || !/(^|\.)drive\.google\.com$/i.test(url.hostname)) return "";
    const pathMatch = url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
    const candidate = (pathMatch && pathMatch[1]) || url.searchParams.get("id") || "";
    return /^[a-zA-Z0-9_-]{10,}$/.test(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

export function parseDriveUrls(value: unknown): string[] {
  const matches = String(value || "").match(/https:\/\/drive\.google\.com\/[^\s<>"']+/gi) || [];
  const seenIds = new Set<string>();
  const urls: string[] = [];
  matches.forEach((rawUrl) => {
    const url = rawUrl.replace(/[)\]，。；;]+$/g, "");
    const fileId = extractDriveFileId(url);
    if (!fileId || seenIds.has(fileId)) return;
    seenIds.add(fileId);
    urls.push(url);
  });
  return urls;
}

export function normalizeBatchSize(
  value: unknown,
  defaults: { defaultValue?: number; min?: number; max?: number } = {}
): number {
  const defaultValue = Number.isFinite(defaults.defaultValue) ? defaults.defaultValue! : 10;
  const min = Number.isFinite(defaults.min) ? defaults.min! : 1;
  const max = Number.isFinite(defaults.max) ? defaults.max! : 25;
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

export function chunkItems<T>(items: T[], size: number): Array<{ offset: number; items: T[] }> {
  const input = Array.isArray(items) ? items : [];
  const chunkSize = Math.max(1, Number.parseInt(String(size || ""), 10) || 1);
  const chunks: Array<{ offset: number; items: T[] }> = [];
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    chunks.push({ offset, items: input.slice(offset, offset + chunkSize) });
  }
  return chunks;
}

export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const input = Array.isArray(items) ? items : [];
  const results = new Array<R>(input.length);
  const workerCount = Math.min(input.length, Math.max(1, Number.parseInt(String(concurrency || ""), 10) || 1));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.length) return;
      results[index] = await mapper(input[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function isRetryableNetworkError(error: unknown): boolean {
  const candidate = error as { message?: string } | null;
  const message = String(candidate?.message || error || "");
  const statusMatch = message.match(/HTTP\s+(\d{3})/i);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
  return /超时|failed to fetch|network|connection|temporar/i.test(message);
}

export function formatBytes(value: unknown): string {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(value: unknown): string {
  const seconds = Math.max(0, Math.round((Number(value) || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
}
