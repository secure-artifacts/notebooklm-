import test from "node:test";
import assert from "node:assert/strict";
import { applyWorkspaceCommand as apply, emptyWorkspace, newRow, providerForUrl, rowComplete, migrateLegacyJob,
  parseTsv, serializeTsv, registrationKey, mergeWorkspaceChange } from "../src/lib/recordWorkspace";
import { createFacebookJob } from "../src/lib/facebookQueue";

const drive = "https://drive.google.com/file/d/1234567890abcdef/view";
const facebook = "https://www.facebook.com/reel/123456789012345";
test("running lease blocks edits even to rows not yet started", () => {
  const state = apply(fixture(), { type: "claim" }, 1);
  assert.throws(() => apply(state, { type: "edit", cells: [{ rowId: "b", field: "url", value: drive }] }, 1), /暂停/);
  const paused = apply(state, { type: "release" }, 1);
  assert.equal(apply(paused, { type: "edit", cells: [{ rowId: "b", field: "url", value: drive }] }, 1).rows[1].url, drive);
});
function fixture() { return apply(emptyWorkspace("notebook"), { type: "add", rows: [newRow("", drive, "a"), newRow("custom", facebook, "b")] }, 1); }

test("unified rows detect both providers and allow optional ID", () => {
  const state = fixture();
  assert.equal(state.rows[0].provider, "drive"); assert.equal(state.rows[0].displayId, "");
  assert.equal(state.rows[1].provider, "facebook");
  assert.equal(providerForUrl("https://fb.com/reel/123456789"), "facebook");
  assert.equal(providerForUrl("https://facebook.com.evil.test/reel/123456"), "");
});
test("identity locks at processing start and cannot be unlocked by a result", () => {
  let state = fixture();
  state = apply(state, { type: "result", rowId: "a", patch: { locked: true, phase: "working" } }, 1);
  assert.throws(() => apply(state, { type: "edit", cells: [{ rowId: "a", field: "displayId", value: "changed" }] }, 1), /锁定/);
  state = apply(state, { type: "result", rowId: "a", patch: { locked: false, phase: "failed" } }, 1);
  assert.equal(state.rows[0].locked, true);
});
test("automatic filename fills a blank ID once and never replaces user ID", () => {
  let state = apply(fixture(), { type: "result", rowId: "a", patch: { displayId: "ignored" }, automaticId: "文件名" }, 1);
  state = apply(state, { type: "result", rowId: "a", patch: {}, automaticId: "new" }, 1);
  state = apply(state, { type: "result", rowId: "b", patch: {}, automaticId: "detected" }, 1);
  assert.deepEqual(state.rows.map((r) => r.displayId), ["文件名", "custom"]);
});
test("multi-cell paste fails atomically when one row is locked", () => {
  const state = apply(fixture(), { type: "result", rowId: "b", patch: { locked: true } }, 1);
  assert.throws(() => apply(state, { type: "edit", cells: [
    { rowId: "a", field: "displayId", value: "first" }, { rowId: "b", field: "url", value: drive }
  ], additions: [newRow("new", facebook, "c")] }, 1), /锁定/);
  assert.equal(state.rows.length, 2); assert.equal(state.rows[0].displayId, "");
});
test("paste updates and adds rows in one revision", () => {
  const state = fixture();
  const next = apply(state, { type: "edit", cells: [{ rowId: "a", field: "url", value: facebook }], additions: [newRow("", drive, "c")] }, 1);
  assert.equal(next.revision, state.revision + 1); assert.equal(next.rows.length, 3); assert.equal(next.rows[0].provider, "facebook");
});
test("row limit is 1000 and rejected additions do not mutate state", () => {
  const state = apply(emptyWorkspace("n"), { type: "add", rows: Array.from({ length: 1000 }, (_, i) => newRow("", drive, String(i))) }, 1);
  assert.throws(() => apply(state, { type: "edit", cells: [], additions: [newRow("", drive, "overflow")] }, 1), /1000/);
  assert.equal(state.rows.length, 1000);
});
test("queue lease blocks another tab and deletion until released", () => {
  let state = apply(fixture(), { type: "claim" }, 1, 100);
  assert.throws(() => apply(state, { type: "claim" }, 2, 200), /另一个标签页/);
  assert.throws(() => apply(state, { type: "delete", rowIds: ["a"] }, 1, 200), /先暂停/);
  state = apply(state, { type: "release" }, 1, 200);
  state = apply(state, { type: "delete", rowIds: ["a", "b"] }, 1, 300);
  assert.deepEqual(state.rows, []);
});
test("expired lease can be recovered and heartbeat cannot silently reacquire", () => {
  const state = apply(fixture(), { type: "claim" }, 1, 0);
  assert.throws(() => apply(state, { type: "heartbeat" }, 1, 90_001), /失效/);
  assert.equal(apply(state, { type: "claim" }, 2, 90_001).lease?.tabId, 2);
});
test("AI cleanup eligibility requires actual translated text", () => {
  const row = newRow(); row.transcript = "original";
  assert.equal(rowComplete(row, false), true); assert.equal(rowComplete(row, true), false);
  row.translationError = "paused"; assert.equal(rowComplete(row, true), false);
  row.translation = "中文"; row.translationError = ""; assert.equal(rowComplete(row, true), true);
  row.error = "failed"; assert.equal(rowComplete(row, true), false);
});
test("TSV preserves multiline Unicode, quotes, blank cells and tabs", () => {
  const rows = [["ID", "链接", "缅文\n原文\t段落", '中文"引号"'], ["", facebook, "", ""]];
  assert.deepEqual(parseTsv(serializeTsv(rows)), rows);
  assert.deepEqual(parseTsv(`a\tb\r\nc\td\r\n`), [["a", "b"], ["c", "d"]]);
});
test("registration receipt is a bounded fingerprint of all exported content", async () => {
  const row = newRow("id"); row.transcript = "long".repeat(10000);
  const first = await registrationKey(row); assert.equal(first.length, 64);
  assert.equal(await registrationKey({ ...row }), first);
  assert.notEqual(await registrationKey({ ...row, translation: "中文" }), first);
});
test("delta merge keeps one ordered row collection and removes full bodies", () => {
  const state = fixture(), modified = { ...state.rows[0], transcript: "body" };
  const next = mergeWorkspaceChange(state, { revision: 3, widths: state.widths, upserts: [modified, newRow("c", drive, "c")], deleted: ["b"] });
  assert.deepEqual(next.rows.map((r) => r.rowId), ["a", "c"]); assert.equal(next.rows[0].transcript, "body");
});
test("migration preserves unmatched results and explicit IDs", () => {
  const job = createFacebookJob("notebook", [{ taskId: "task", postId: "custom", url: facebook }], { autoDelete: true, translate: true, autoRegister: false });
  job.records = [{ sourceId: "source", sourceName: "custom.mp4", transcript: "原文", translation: "中文" }, { sourceId: "orphan", sourceName: "other.mp3", transcript: "保留" }];
  const state = migrateLegacyJob("notebook", job);
  assert.equal(state.rows.length, 2); assert.equal(state.rows[0].displayId, "custom");
  assert.equal(state.rows[0].translation, "中文"); assert.equal(state.rows[0].locked, true); assert.equal(state.rows[1].provider, "existing");
});
