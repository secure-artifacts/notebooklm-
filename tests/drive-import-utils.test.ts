import test from "node:test";
import assert from "node:assert/strict";
import * as utils from "../src/lib/driveImport";

test("parseDriveUrls accepts supported links, trims punctuation and deduplicates by file id", () => {
  const first = "1N6FrMwiFSIC7FHWJwAoion21nrn30Dqe";
  const second = "1ABCdefghijkLMNOPqrstuvwxyz_234567";
  const value = [
    `https://drive.google.com/file/d/${first}/view?usp=drive_link，`,
    `https://drive.google.com/open?id=${first}`,
    `文字 https://drive.google.com/file/d/${second}/view)`
  ].join("\n");

  assert.deepEqual(utils.parseDriveUrls(value), [
    `https://drive.google.com/file/d/${first}/view?usp=drive_link`,
    `https://drive.google.com/file/d/${second}/view`
  ]);
});

test("extractDriveFileId rejects non-Drive and malformed links", () => {
  assert.equal(utils.extractDriveFileId("https://example.com/file/d/1234567890"), "");
  assert.equal(utils.extractDriveFileId("https://drive.google.com/file/d/short/view"), "");
  assert.equal(utils.extractDriveFileId("not a url"), "");
});

test("normalizeBatchSize and chunkItems enforce bounded deterministic batches", () => {
  const options = { defaultValue: 10, min: 1, max: 25 };
  assert.equal(utils.normalizeBatchSize("", options), 10);
  assert.equal(utils.normalizeBatchSize(0, options), 10);
  assert.equal(utils.normalizeBatchSize(-5, options), 1);
  assert.equal(utils.normalizeBatchSize(99, options), 25);
  assert.deepEqual(utils.chunkItems([1, 2, 3, 4, 5], 2), [
    { offset: 0, items: [1, 2] },
    { offset: 2, items: [3, 4] },
    { offset: 4, items: [5] }
  ]);
});

test("mapConcurrent preserves input ordering and respects the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const result = await utils.mapConcurrent([3, 1, 2, 4], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 10;
  });

  assert.deepEqual(result, [30, 10, 20, 40]);
  assert.equal(peak, 2);
});

test("network retry classification keeps permanent HTTP failures final", () => {
  assert.equal(utils.isRetryableNetworkError(new Error("HTTP 429")), true);
  assert.equal(utils.isRetryableNetworkError(new Error("HTTP 503")), true);
  assert.equal(utils.isRetryableNetworkError(new Error("HTTP 404")), false);
  assert.equal(utils.isRetryableNetworkError(new Error("network connection failed")), true);
});

test("formatters keep the existing Chinese UI contract", () => {
  assert.equal(utils.formatBytes(1536), "1.5 KB");
  assert.equal(utils.formatDuration(61000), "1 分 1 秒");
});
