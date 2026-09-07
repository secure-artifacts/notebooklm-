import test from "node:test";
import assert from "node:assert/strict";
import * as utils from "../src/lib/aiTranslation";

test("stripSourceSuffix removes media suffixes and URL decorations", () => {
  assert.equal(utils.stripSourceSuffix("示例音频.mp3"), "示例音频");
  assert.equal(utils.stripSourceSuffix("source.MP4?download=1"), "source");
  assert.equal(utils.stripSourceSuffix("#123456"), "#123456");
});

test("AI translation batch size is clamped between 1 and 20", () => {
  assert.equal(utils.normalizeAiTranslationBatchSize(""), 5);
  assert.equal(utils.normalizeAiTranslationBatchSize(0), 1);
  assert.equal(utils.normalizeAiTranslationBatchSize(7), 7);
  assert.equal(utils.normalizeAiTranslationBatchSize(99), 20);
});

test("sourceNamesMatch ignores suffix, case and repeated whitespace", () => {
  assert.equal(utils.sourceNamesMatch("My   Audio.mp3", "my audio.MP3"), true);
  assert.equal(utils.sourceNamesMatch("first.mp3", "second.mp3"), false);
});

test("extractJsonArrayCandidates handles noise and brackets inside strings", () => {
  const text = '说明文字 [{"source_name":"A","zh":"完整 [中文] 翻译"}] 其他文字';
  const candidates = utils.extractJsonArrayCandidates(text);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].value, [
    { source_name: "A", zh: "完整 [中文] 翻译" }
  ]);
});

test("extractJsonArrayCandidates ignores incomplete streamed JSON", () => {
  const candidates = utils.extractJsonArrayCandidates('[{"source_name":"A","zh":"未完成"');
  assert.deepEqual(candidates, []);
});

test("mergeTranslationPayload matches records and reports missing or unknown rows", () => {
  const records: any[] = [
    { sourceName: "one", sourceOriginalName: "one.mp3", translationError: "old" },
    { sourceName: "two", sourceOriginalName: "two.mp4" }
  ];
  const result = utils.mergeTranslationPayload([
    { source_name: "ONE", zh: " 翻译一 " },
    { source_name: "unknown", zh: "未知" },
    { source_name: "two", zh: "" }
  ], records);

  assert.equal(result.translated.length, 1);
  assert.equal(result.translated[0], records[0]);
  assert.equal(records[0].translation, "翻译一");
  assert.equal(records[0].translationError, "");
  assert.deepEqual(result.missing, [records[1]]);
  assert.equal(result.unknown.length, 2);
});

test("buildTranslationPrompt keeps the strict JSON contract", () => {
  const prompt = utils.buildTranslationPrompt();
  assert.match(prompt, /合法 JSON 数组/);
  assert.match(prompt, /中国大陆通用的简体中文/);
  assert.match(prompt, /根据转录原文完整翻译/);
  assert.match(prompt, /不需要深度思考/);
  assert.match(prompt, /完整简体中文翻译/);
  assert.match(prompt, /"source_name"/);
  assert.match(prompt, /"zh"/);
});
