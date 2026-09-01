import test from "node:test";
import assert from "node:assert/strict";
import * as utils from "../src/lib/sheetRegistration";

test("sheet URLs use the same strict validation contract", () => {
  assert.equal(utils.validDeploymentUrl("https://script.google.com/macros/s/abc123/exec"), true);
  assert.equal(utils.validDeploymentUrl("http://script.google.com/macros/s/abc123/exec"), false);
  assert.equal(utils.validDatabaseUrl("https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=123"), true);
  assert.equal(utils.validDatabaseUrl("https://docs.google.com/spreadsheets/d/sheet-id/edit"), false);
});

test("toSheetRecords maps the three backend fields without changing content", () => {
  const records = utils.toSheetRecords([
    { sourceName: "one.mp3", transcript: "原文", translation: "中文" },
    { sourceName: "two.mp4", transcript: "第二条" }
  ] as any, (name) => name.replace(/\.[^.]+$/, ""));

  assert.deepEqual(records, [
    { post_id: "one", audio_content: "原文", audio_content_zh: "中文" },
    { post_id: "two", audio_content: "第二条", audio_content_zh: "" }
  ]);
});

test("analyzeBatchResponse counts success and keeps failed record details", () => {
  const records = [{ post_id: "one" }, { post_id: "two" }] as any;
  const result = utils.analyzeBatchResponse({
    ok: true,
    data: {
      summary: { success: 1, failed: 1, status_counts: { inserted: 1, invalid: 1 } },
      results: [
        { index: 0, post_id: "one", success: true },
        { index: 1, post_id: "two", success: false, error: { code: "INVALID", message: "格式错误" } }
      ]
    }
  }, records, { batchLabel: "1/1", batchStart: 0 });

  assert.equal(result.success, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual({ ...result.statusCounts }, { inserted: 1, invalid: 1 });
  assert.match(result.failureLogs[0].message, /two \[INVALID\]：格式错误/);
});

test("analyzeBatchResponse treats unreported and request-level failures as failed", () => {
  const records = [{ post_id: "one" }, { post_id: "two" }] as any;
  const partial = utils.analyzeBatchResponse({
    ok: true,
    data: { summary: { success: 1 }, results: [{ index: 0, success: true }] }
  }, records, { batchLabel: "1/1" });
  assert.equal(partial.success, 1);
  assert.equal(partial.failed, 1);
  assert.equal(partial.statusCounts.unreported_result, 1);

  const failed = utils.analyzeBatchResponse({
    ok: false,
    http_status: 500,
    request_id: "req-1",
    error: { code: "SERVER", message: "服务异常" }
  }, records, { batchLabel: "1/1" });
  assert.equal(failed.requestFailed, true);
  assert.equal(failed.failed, 2);
  assert.equal(failed.statusCounts.request_failed, 2);
  assert.match(failed.failureLogs[0].message, /req-1/);
});

test("status_counts formatting remains directly copyable", () => {
  const counts = Object.create(null);
  utils.addStatusCount(counts, "inserted", 2);
  utils.mergeStatusCounts(counts, { inserted: 1, updated: 3 });
  assert.equal(utils.formatStatusCounts(counts), 'status_counts\n{\n  "inserted": 3,\n  "updated": 3\n}');
});

test("sheet registration batches honor both record count and UTF-8 payload size", () => {
  const records = Array.from({ length: 5 }, (_, index) => ({
    post_id: `post-${index}`,
    audio_content: "缅甸语".repeat(30),
    audio_content_zh: "中文".repeat(30)
  }));
  const batches = utils.chunkSheetRegistrationRecords(records, "https://docs.google.com/spreadsheets/d/a/edit?gid=1", {
    maxRecords: 200,
    maxPayloadBytes: 700
  });

  assert.equal(batches.flat().length, records.length);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.length === 1 ||
    utils.sheetRegistrationPayloadBytes("https://docs.google.com/spreadsheets/d/a/edit?gid=1", batch) <= 700));
});

test("sheet registration recognizes structured and textual 413 failures", () => {
  assert.equal(utils.isSheetRequestTooLarge({ http_status: 413 }), true);
  assert.equal(utils.isSheetRequestTooLarge({ error: { code: "REQUEST_TOO_LARGE" } }), true);
  assert.equal(utils.isSheetRequestTooLarge(new Error("HTTP 413: request entity too large")), true);
  assert.equal(utils.isSheetRequestTooLarge({ http_status: 500 }), false);
});

test("sheet registration failure logs summarize long post id lists", () => {
  const records = Array.from({ length: 15 }, (_, index) => ({ post_id: `post-${index}` })) as any;
  assert.equal(
    utils.summarizeSheetPostIds(records, 3),
    "post-0、post-1、post-2；另有 12 条"
  );
});
