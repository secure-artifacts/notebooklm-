type JsonArray = unknown[];
type DebugError = Error & { debug?: unknown };

export type SourceStatus = {
  ready: boolean;
  failed: boolean;
  stateCode: number | null;
  metaCode: number | null;
  mime: string | null;
  hasBlobId: boolean;
};

export type SourceRecord = {
  sourceId: string;
  sourceName: string;
};

export function sourceOptions(): unknown[] {
  return [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]];
}

export function parseBatchexecuteChunks(
  text: unknown,
  onParseError?: (error: Error, line: string) => void
): unknown[] {
  const lines = String(text || "").split("\n");
  const chunks: unknown[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line || line === ")]}'") {
      index += 1;
      continue;
    }
    if (/^\d+$/.test(line) && index + 1 < lines.length) {
      parseChunkLine(lines[index + 1], chunks, onParseError);
      index += 2;
      continue;
    }
    if (line.startsWith("[") || line.startsWith("{")) parseChunkLine(line, chunks, onParseError);
    index += 1;
  }
  return chunks;
}

function parseChunkLine(
  line: string,
  chunks: unknown[],
  onParseError?: (error: Error, line: string) => void
): void {
  try {
    chunks.push(JSON.parse(line));
  } catch (error) {
    if (onParseError) onParseError(error as Error, line);
  }
}

export function extractRpcPayload(
  text: unknown,
  rpcid: string,
  onParseError?: (error: Error, line: string) => void
): unknown {
  const chunks = parseBatchexecuteChunks(text, onParseError);
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    for (const row of chunk) {
      if (Array.isArray(row) && row[0] === "wrb.fr" && row[1] === rpcid) {
        try {
          return JSON.parse(String(row[2]));
        } catch (error) {
          throw new Error(`Could not parse ${rpcid} payload: ${(error as Error).message}`);
        }
      }
    }
  }
  const error = new Error(`No wrb.fr payload found for ${rpcid}.`) as DebugError;
  error.debug = {
    rpcid,
    chunks: summarizePayload(chunks),
    responsePreview: String(text || "").slice(0, 1500)
  };
  throw error;
}

export function findSourceEntry(notebookPayload: unknown, sourceId: string): JsonArray | null {
  return findSourceArray(notebookPayload, sourceId);
}

function findSourceArray(node: unknown, sourceId: string): JsonArray | null {
  if (!Array.isArray(node)) return null;
  if (Array.isArray(node[0]) && node[0].includes(sourceId) && node.some((item) => typeof item === "string")) {
    return node;
  }
  for (const item of node) {
    const match = findSourceArray(item, sourceId);
    if (match) return match;
  }
  return null;
}

export function extractSourceRecords(
  notebookPayload: unknown,
  projectId: string,
  visibleNames: string[] = []
): SourceRecord[] {
  const ids = Array.from(new Set(
    (safeStringify(notebookPayload).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])
      .filter((id) => id !== projectId)
  ));
  const records: SourceRecord[] = [];
  const seenEntries = new Set<string>();

  for (const sourceId of ids) {
    const entry = findSourceEntry(notebookPayload, sourceId);
    if (!entry) continue;
    const entryKey = safeStringify(entry);
    if (seenEntries.has(entryKey)) continue;
    const status = summarizeSourceStatus(entry);
    const inferredName = extractSourceName(entry, sourceId, projectId);
    if (!status.ready && !looksLikeSourceName(inferredName)) continue;
    seenEntries.add(entryKey);
    records.push({ sourceId, sourceName: inferredName });
  }

  return records.map((record, index) => ({
    ...record,
    sourceName: visibleNames[index] || record.sourceName || `来源 ${index + 1}`
  }));
}

function extractSourceName(entry: JsonArray, sourceId: string, projectId: string): string {
  const strings: string[] = [];
  collectStrings(entry, strings);
  const candidates = strings
    .map((value) => String(value || "").trim())
    .filter((value) => value && value !== sourceId && value !== projectId)
    .filter((value) => value.length <= 512)
    .filter((value) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    .filter((value) => !/^(video|audio)\/[a-z0-9.+-]+$/i.test(value));
  candidates.sort((left, right) => scoreSourceName(right) - scoreSourceName(left));
  return candidates[0] || "";
}

function collectStrings(node: unknown, output: string[]): void {
  if (typeof node === "string") {
    output.push(node);
    return;
  }
  if (!Array.isArray(node)) return;
  for (const item of node) collectStrings(item, output);
}

function scoreSourceName(value: string): number {
  let score = 0;
  if (/(?:mp3|mp4|m4a|wav|pdf|docx?|txt|csv|pptx?|xlsx?)$/i.test(value)) score += 100;
  if (/^(?:https?;|https?:\/\/|www\.)/i.test(value)) score += 80;
  if (/\.[a-z0-9]{2,5}(?:[?#].*)?$/i.test(value)) score += 30;
  if (/\s/.test(value)) score += 8;
  return score;
}

function looksLikeSourceName(value: string): boolean {
  return scoreSourceName(value) >= 30;
}

export function summarizeSourceStatus(source: unknown): SourceStatus {
  const text = JSON.stringify(source);
  const mime = firstMatch(text, /(?:video|audio)\/[a-zA-Z0-9.+-]+/);
  const uuidCount = (text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).length;
  const stateCode = directSourceStateCode(source);
  const metaCodes = collectTupleCodes(source, 1);
  const failed = stateCode === 3;
  const metaCode = metaCodes.includes(1) ? 1 : metaCodes[0] ?? null;
  const ready = stateCode === 2 || (stateCode === null && Boolean(mime && uuidCount > 1 && metaCode === 1));
  return { ready, failed, stateCode, metaCode, mime: mime || null, hasBlobId: uuidCount > 1 };
}

function directSourceStateCode(source: unknown): number | null {
  if (!Array.isArray(source)) return null;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const item = source[index];
    if (Array.isArray(item) && item[0] === null && typeof item[1] === "number" && [1, 2, 3, 5].includes(item[1])) {
      return item[1];
    }
  }
  return null;
}

function collectTupleCodes(node: unknown, firstValue: unknown, output: number[] = []): number[] {
  if (!Array.isArray(node)) return output;
  if (node.length >= 2 && node[0] === firstValue && typeof node[1] === "number") output.push(node[1]);
  for (const item of node) collectTupleCodes(item, firstValue, output);
  return output;
}

export function extractTranscriptText(
  payload: unknown,
  context: { sourceId: string; projectId: string; fileName?: string }
): string {
  const segments: string[] = [];
  collectTimedStrings(payload, false, segments);
  return collapseConsecutiveDuplicates(segments)
    .map(cleanTranscriptLine)
    .filter(Boolean)
    .filter((text) => isTranscriptLine(text, context))
    .join("\n")
    .trim();
}

function collectTimedStrings(node: unknown, inTimedSegment: boolean, output: string[]): void {
  if (typeof node === "string") {
    if (inTimedSegment) output.push(node);
    return;
  }
  if (!Array.isArray(node)) return;
  const nextTimed = inTimedSegment ||
    (typeof node[0] === "number" && typeof node[1] === "number" && Array.isArray(node[2]));
  for (const child of node) collectTimedStrings(child, nextTimed, output);
}

function cleanTranscriptLine(text: string): string {
  return String(text || "").replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

function isTranscriptLine(
  text: string,
  context: { sourceId: string; projectId: string; fileName?: string }
): boolean {
  if (!text || text === context.sourceId || text === context.projectId) return false;
  if (context.fileName && text === context.fileName) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return false;
  return !/^(video|audio)\/[a-z0-9.+-]+$/i.test(text);
}

export function firstUuid(text: unknown, excluded?: string): string {
  const matches = String(text || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
  return matches.find((match) => match !== excluded) || "";
}

export function firstMatch(text: unknown, regex: RegExp): string {
  const match = String(text || "").match(regex);
  return match ? match[1] || match[0] : "";
}

function collapseConsecutiveDuplicates<T>(items: T[]): T[] {
  const output: T[] = [];
  let previous: T | null = null;
  for (const item of items) {
    if (item !== previous) output.push(item);
    previous = item;
  }
  return output;
}

export function isRetryableUploadError(error: unknown): boolean {
  const candidate = error as { message?: string; debug?: { status?: number } } | null;
  const status = Number(candidate?.debug?.status) || 0;
  if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
  const message = String(candidate?.message || error || "");
  return /failed to fetch|network|connection|timeout|temporar/i.test(message);
}

export function summarizePayload(payload: unknown) {
  const text = safeStringify(payload);
  return {
    type: Array.isArray(payload) ? "array" : typeof payload,
    length: Array.isArray(payload) ? payload.length : undefined,
    preview: text.length > 1200 ? `${text.slice(0, 1200)}...` : text
  };
}

export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    });
  } catch {
    return String(value);
  }
}
