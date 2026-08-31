export const colabBridgePrefix = "NLM_BRIDGE:";
export const colabBridgeProtocol = 1 as const;

export type ColabTaskStatus = "queued" | "downloading" | "downloaded" | "uploading" | "uploaded" | "failed";

export type ColabBridgeEvent =
  | {
      event_id: string;
      type: "ready";
      protocol: typeof colabBridgeProtocol;
      python?: string;
      platform?: string;
    }
  | {
      event_id: string;
      type: "control";
      protocol: typeof colabBridgeProtocol;
      session_id: string;
      base_url: string;
      token: string;
    }
  | {
      event_id: string;
      type: "task";
      task_id: string;
      status: ColabTaskStatus;
      file_name?: string;
      mime_type?: string;
      size?: number;
      source_id?: string;
      error?: string;
    }
  | {
      event_id: string;
      type: "complete";
      total: number;
      succeeded: number;
      failed: number;
    }
  | {
      event_id: string;
      type: "fatal";
      code: string;
      message: string;
    };

export type FacebookDownloadTask = {
  taskId: string;
  postId: string;
  url: string;
};

export type FacebookTaskParseResult = {
  tasks: FacebookDownloadTask[];
  errors: string[];
};

export type FacebookTableInput = { postId: string; url: string };
export type FacebookTableIssue = { index: number; message: string };
export type FacebookTableParseResult = FacebookTaskParseResult & { issues: FacebookTableIssue[] };
export type FacebookClipboardRow = FacebookTableInput & { twoColumns: boolean };

const facebookHosts = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "web.facebook.com",
  "fb.watch"
]);

const trailingPunctuation = /[)\]}>,，。；;！!？?]+$/u;

export function normalizeFacebookUrl(value: string): string {
  const cleaned = value.trim().replace(trailingPunctuation, "");
  try {
    const url = new URL(cleaned);
    if (url.protocol !== "https:" || !facebookHosts.has(url.hostname.toLowerCase())) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizePostId(value: string, fallbackIndex: number): string {
  const normalized = value
    .trim()
    .replace(/^['"“”]+|['"“”]+$/gu, "")
    .replace(/\.(?:mp4|mov|m4v|webm|mp3|m4a|wav)$/iu, "")
    .replace(/[\\/:*?"<>|]+/gu, "_")
    .trim();
  return normalized || `facebook_${fallbackIndex + 1}`;
}

export function parseFacebookTableRows(rows: FacebookTableInput[], maxTasks = 1000): FacebookTableParseResult {
  const tasks: FacebookDownloadTask[] = [];
  const errors: string[] = [];
  const issues: FacebookTableIssue[] = [];
  const seenUrls = new Set<string>();
  const seenPostIds = new Set<string>();

  rows.forEach((row, index) => {
    const rawPostId = String(row?.postId || "").trim();
    const rawUrl = String(row?.url || "").trim();
    if (!rawPostId && !rawUrl) return;
    if (tasks.length >= maxTasks) {
      issues.push({ index, message: `一次最多 ${maxTasks} 条。` });
      return;
    }
    if (!rawPostId) {
      issues.push({ index, message: "缺少贴文 ID。" });
      return;
    }
    const postId = normalizePostId(rawPostId, index);
    if (seenPostIds.has(postId)) {
      issues.push({ index, message: "贴文 ID 重复。" });
      return;
    }
    const url = normalizeFacebookUrl(rawUrl);
    if (!url) {
      issues.push({ index, message: "请输入有效的 Facebook HTTPS 公开链接。" });
      return;
    }
    if (seenUrls.has(url)) {
      issues.push({ index, message: "链接重复。" });
      return;
    }
    tasks.push({ taskId: `fb-${tasks.length + 1}`, postId, url });
    seenPostIds.add(postId);
    seenUrls.add(url);
  });

  issues.forEach((issue) => errors.push(`第 ${issue.index + 1} 行：${issue.message}`));
  return { tasks, errors, issues };
}

export function parseFacebookClipboardRows(text: string): FacebookClipboardRow[] {
  return String(text || "").split(/\r?\n/u).filter((line) => Boolean(line.trim())).map((line) => {
    const columns = line.split("\t").map((cell) => cell.trim());
    if (columns.length >= 2) return { postId: columns[0], url: columns[1], twoColumns: true };
    const urlMatch = line.match(/https:\/\/[^\s]+/iu);
    if (urlMatch) {
      const postId = line.slice(0, urlMatch.index).trim();
      return { postId, url: urlMatch[0], twoColumns: Boolean(postId) };
    }
    return { postId: line.trim(), url: "", twoColumns: false };
  });
}

export function parseFacebookTasks(input: string, maxTasks = 30): FacebookTaskParseResult {
  const tasks: FacebookDownloadTask[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const urlPattern = /https:\/\/(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.watch)\/[^\s<>"']+/iu;

  for (const [index, rawLine] of input.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(urlPattern);
    if (!match) {
      errors.push(`第 ${index + 1} 行没有可识别的 Facebook 公共链接。`);
      continue;
    }

    const url = normalizeFacebookUrl(match[0]);
    if (!url) {
      errors.push(`第 ${index + 1} 行的 Facebook 链接无效或不是 HTTPS。`);
      continue;
    }
    if (seen.has(url)) continue;
    if (tasks.length >= maxTasks) {
      errors.push(`一次最多 ${maxTasks} 条，后续链接未加入。`);
      break;
    }

    const postId = normalizePostId(line.slice(0, match.index).trim(), tasks.length);
    tasks.push({ taskId: `fb-${tasks.length + 1}`, postId, url });
    seen.add(url);
  }

  return { tasks, errors };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseBridgeEvent(value: unknown): ColabBridgeEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (typeof event.event_id !== "string" || !event.event_id.trim()) return null;

  if (event.type === "ready") {
    if (event.protocol !== colabBridgeProtocol) return null;
    return event as ColabBridgeEvent;
  }
  if (event.type === "control") {
    if (event.protocol !== colabBridgeProtocol || typeof event.session_id !== "string" || !event.session_id.trim()) return null;
    if (!normalizeGradioControlUrl(event.base_url) || typeof event.token !== "string" || event.token.length < 32) return null;
    return { ...event, base_url: normalizeGradioControlUrl(event.base_url) } as ColabBridgeEvent;
  }
  if (event.type === "task") {
    if (typeof event.task_id !== "string") return null;
    if (!["queued", "downloading", "downloaded", "uploading", "uploaded", "failed"].includes(String(event.status))) return null;
    if (event.size !== undefined && !isNonNegativeInteger(event.size)) return null;
    return event as ColabBridgeEvent;
  }
  if (event.type === "complete") {
    if (![event.total, event.succeeded, event.failed].every(isNonNegativeInteger)) return null;
    if ((event.succeeded as number) + (event.failed as number) !== event.total) return null;
    return event as ColabBridgeEvent;
  }
  if (event.type === "fatal") {
    if (typeof event.code !== "string" || typeof event.message !== "string") return null;
    return event as ColabBridgeEvent;
  }
  return null;
}

export function parseColabBridgeOutput(output: string): ColabBridgeEvent[] {
  const events: ColabBridgeEvent[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < output.length) {
    const prefixIndex = output.indexOf(colabBridgePrefix, cursor);
    if (prefixIndex < 0) break;
    const jsonStart = prefixIndex + colabBridgePrefix.length;
    const jsonEnd = findJsonObjectEnd(output, jsonStart);
    if (jsonEnd < 0) {
      cursor = jsonStart;
      continue;
    }
    try {
      const event = parseBridgeEvent(JSON.parse(output.slice(jsonStart, jsonEnd)));
      if (!event || seen.has(event.event_id)) {
        cursor = jsonEnd;
        continue;
      }
      seen.add(event.event_id);
      events.push(event);
    } catch {
      // Colab may expose partially rendered output while a cell is still running.
    }
    cursor = jsonEnd;
  }
  return events;
}

function findJsonObjectEnd(value: string, start: number): number {
  let cursor = start;
  while (/\s/u.test(value[cursor] || "")) cursor += 1;
  if (value[cursor] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; cursor < value.length; cursor += 1) {
    const char = value[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return cursor + 1;
  }
  return -1;
}

export type GithubColabNotebook = {
  owner: string;
  repository: string;
  ref?: string;
  path: string;
  language?: string;
  sessionId?: string;
  targetTabId?: number;
};

function assertGithubSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(normalized)) throw new Error(`${label} 无效。`);
  return normalized;
}

export function buildGithubColabUrl(options: GithubColabNotebook): string {
  const owner = assertGithubSegment(options.owner, "GitHub 所有者");
  const repository = assertGithubSegment(options.repository, "GitHub 仓库名");
  const ref = assertGithubSegment(options.ref || "main", "Git 引用");
  const path = options.path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  if (!path.endsWith(".ipynb")) throw new Error("Colab 模板必须是 .ipynb 文件。");

  const url = new URL(`https://colab.research.google.com/github/${owner}/${repository}/blob/${ref}/${path}`);
  url.searchParams.set("playground", "true");
  if (options.language) url.searchParams.set("hl", options.language);
  if (options.sessionId) url.searchParams.set("nlm_session", options.sessionId);
  if (Number.isSafeInteger(options.targetTabId) && Number(options.targetTabId) >= 0) {
    url.searchParams.set("nlm_target", String(options.targetTabId));
  }
  return url.toString();
}

export function buildColabScratchpadUrl(sessionId: string, language = "zh-CN"): string {
  if (!/^[A-Za-z0-9_-]{12,100}$/u.test(sessionId)) throw new Error("Colab 会话编号无效。");
  const url = new URL("https://colab.research.google.com/notebooks/empty.ipynb");
  url.searchParams.set("nlm_session", sessionId);
  if (language) url.searchParams.set("hl", language);
  return url.toString();
}

export function normalizeGradioControlUrl(value: unknown): string {
  try {
    const url = new URL(String(value || "").trim());
    const trustedHost = /^[a-z0-9-]+\.(?:gradio\.live|trycloudflare\.com|loca\.lt)$/iu.test(url.hostname);
    if (url.protocol !== "https:" || !trustedHost) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function parseGradioSseData(body: string): unknown[] {
  const results: unknown[] = [];
  for (const block of String(body || "").split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const eventType = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    if (eventType && eventType !== "complete") continue;
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) results.push(...parsed);
      else results.push(parsed);
    } catch {
      // Ignore streaming heartbeats and incomplete frames.
    }
  }
  return results;
}

export function decodeColabControlValue(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3 && Array.isArray(current) && current.length === 1; depth += 1) {
    current = current[0];
  }
  if (typeof current === "string") {
    try {
      return JSON.parse(current);
    } catch {
      return current;
    }
  }
  return current;
}

export function parseColabControlEvents(value: unknown): ColabBridgeEvent[] {
  const decoded = decodeColabControlValue(value);
  if (!Array.isArray(decoded)) return [];
  const events: ColabBridgeEvent[] = [];
  for (const item of decoded) {
    const event = parseBridgeEvent(item);
    if (event) events.push(event);
  }
  return events;
}

export type ColabFailureCode =
  | "third_party_cookies"
  | "runtime_quota"
  | "runtime_unavailable"
  | "login_required"
  | "output_unreadable"
  | "unknown";

export function classifyColabFailure(message: string): ColabFailureCode {
  const value = message.toLowerCase();
  if (/third[- ]party cookie|第三方 cookie|第三方 Cookie/u.test(message)) return "third_party_cookies";
  if (/quota|usage limit|配额|用量上限/u.test(value)) return "runtime_quota";
  if (/sign in|login|登录|登入/u.test(value)) return "login_required";
  if (/allocat|runtime unavailable|无法分配|运行时不可用/u.test(value)) return "runtime_unavailable";
  if (/output|输出|iframe|javascript file/u.test(value)) return "output_unreadable";
  return "unknown";
}
