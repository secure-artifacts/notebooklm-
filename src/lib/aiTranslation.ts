import type { TranscriptRecord } from "@/types/domain";

export function stripSourceSuffix(sourceName: unknown): string {
  let value = String(sourceName || "").trim();
  const queryIndex = value.indexOf("?");
  if (queryIndex >= 0) value = value.slice(0, queryIndex);
  const fragmentIndex = value.indexOf("#", 1);
  if (fragmentIndex >= 0) value = value.slice(0, fragmentIndex);
  return value.replace(/\.[a-z0-9]{1,10}$/i, "").trim();
}

export function normalizeSourceName(value: unknown): string {
  return stripSourceSuffix(value).replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function sourceNamesMatch(left: unknown, right: unknown): boolean {
  return Boolean(left && right && normalizeSourceName(left) === normalizeSourceName(right));
}

export function buildTranslationPrompt(): string {
  return [
    "请将当前选中的全部来源分别完整翻译成中国大陆通用的简体中文。",
    "译文必须全部使用简体中文汉字，不得使用繁体中文或繁体字；人名、地名和专有名词也请使用常见的简体中文写法。",
    "不得概括、删减、合并来源。",
    "请仅输出合法 JSON 数组，不要使用 Markdown 代码块，不要解释。",
    "格式必须完全为：",
    '[{"source_name":"来源名","zh":"完整简体中文翻译"}]'
  ].join("\n");
}

export type TranslationPayloadItem = {
  source_name: string;
  zh: string;
};

export function extractJsonArrayCandidates(text: unknown): Array<{ raw: string; value: unknown[] }> {
  const source = String(text || "");
  const candidates: Array<{ raw: string; value: unknown[] }> = [];
  for (let start = source.indexOf("["); start >= 0; start = source.indexOf("[", start + 1)) {
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"') {
        quote = char;
        continue;
      }
      if (char === "[") depth += 1;
      else if (char === "]") {
        depth -= 1;
        if (!depth) {
          const raw = source.slice(start, index + 1);
          try {
            const value = JSON.parse(raw);
            if (Array.isArray(value)) candidates.push({ raw, value });
          } catch {
            // Streaming responses can be incomplete until the final update.
          }
          break;
        }
      }
    }
  }
  return candidates;
}

export function mergeTranslationPayload(payload: unknown, records: TranscriptRecord[]) {
  const unmatchedRecords = records.slice();
  const translated: TranscriptRecord[] = [];
  const unknown: unknown[] = [];
  (Array.isArray(payload) ? payload : []).forEach((item: unknown) => {
    const candidate = item as Partial<TranslationPayloadItem> | null;
    if (!candidate || typeof candidate !== "object" || typeof candidate.source_name !== "string" ||
      typeof candidate.zh !== "string" || !candidate.zh.trim()) {
      unknown.push(item);
      return;
    }
    const index = unmatchedRecords.findIndex((record) =>
      sourceNamesMatch(candidate.source_name, record.sourceOriginalName || record.sourceName));
    if (index < 0) {
      unknown.push(item);
      return;
    }
    const [record] = unmatchedRecords.splice(index, 1);
    record.translation = candidate.zh.trim();
    record.translationError = "";
    translated.push(record);
  });
  return { translated, missing: unmatchedRecords, unknown };
}
