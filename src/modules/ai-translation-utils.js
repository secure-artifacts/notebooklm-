(function (root) {
  "use strict";

  function stripSourceSuffix(sourceName) {
    let value = String(sourceName || "").trim();
    const queryIndex = value.indexOf("?");
    if (queryIndex >= 0) value = value.slice(0, queryIndex);
    const fragmentIndex = value.indexOf("#", 1);
    if (fragmentIndex >= 0) value = value.slice(0, fragmentIndex);
    return value.replace(/\.[a-z0-9]{1,10}$/i, "").trim();
  }

  function normalizeSourceName(value) {
    return stripSourceSuffix(String(value || ""))
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  }

  function sourceNamesMatch(left, right) {
    return Boolean(left && right && normalizeSourceName(left) === normalizeSourceName(right));
  }

  function buildTranslationPrompt() {
    return [
      "请将当前选中的全部来源分别完整翻译成中国大陆通用的简体中文。",
      "译文必须全部使用简体中文汉字，不得使用繁体中文或繁体字；人名、地名和专有名词也请使用常见的简体中文写法。",
      "不得概括、删减、合并来源。",
      "请仅输出合法 JSON 数组，不要使用 Markdown 代码块，不要解释。",
      "格式必须完全为：",
      '[{"source_name":"来源名","zh":"完整简体中文翻译"}]'
    ].join("\n");
  }

  function extractJsonArrayCandidates(text) {
    const source = String(text || "");
    const candidates = [];
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
            } catch (_error) {
              // Streamed answers are often incomplete before the final update.
            }
            break;
          }
        }
      }
    }
    return candidates;
  }

  function mergeTranslationPayload(payload, records) {
    const unmatchedRecords = records.slice();
    const translated = [];
    const unknown = [];
    (Array.isArray(payload) ? payload : []).forEach((item) => {
      if (!item || typeof item !== "object" || typeof item.source_name !== "string" || typeof item.zh !== "string" || !item.zh.trim()) {
        unknown.push(item);
        return;
      }
      const index = unmatchedRecords.findIndex((record) =>
        sourceNamesMatch(item.source_name, record.sourceOriginalName || record.sourceName));
      if (index < 0) {
        unknown.push(item);
        return;
      }
      const [record] = unmatchedRecords.splice(index, 1);
      record.translation = item.zh.trim();
      record.translationError = "";
      translated.push(record);
    });
    return { translated, missing: unmatchedRecords, unknown };
  }

  const api = Object.freeze({
    stripSourceSuffix,
    normalizeSourceName,
    sourceNamesMatch,
    buildTranslationPrompt,
    extractJsonArrayCandidates,
    mergeTranslationPayload
  });

  root.NlmAiTranslationUtils = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
