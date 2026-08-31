import assert from "node:assert/strict";
import test from "node:test";
import { completedSourceIdsForCleanup } from "../src/lib/importCleanup";
import type { TranscriptRecord } from "../src/types/domain";

const records: TranscriptRecord[] = [
  { sourceId: "ready", sourceName: "ready", transcript: "原文", translation: "译文" },
  { sourceId: "untranslated", sourceName: "untranslated", transcript: "原文" },
  { sourceId: "failed", sourceName: "failed", transcript: "", error: "处理失败" },
  { sourceId: "", sourceName: "missing-id", transcript: "原文", translation: "译文" }
];

test("cleanup keeps transcription and translation failures for retry", () => {
  assert.deepEqual(completedSourceIdsForCleanup(records, false), ["ready", "untranslated"]);
  assert.deepEqual(completedSourceIdsForCleanup(records, true), ["ready"]);
});
