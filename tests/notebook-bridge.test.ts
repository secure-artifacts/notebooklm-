import assert from "node:assert/strict";
import test from "node:test";
import { isSafeNotebookPayload, notebookBridgeActions } from "../src/lib/notebookBridge";

test("Notebook bridge rejects unknown actions and implicit delete-all", () => {
  assert.equal(notebookBridgeActions.has("unknown" as never), false);
  assert.equal(isSafeNotebookPayload("delete-sources", { sourceIds: [] }), false);
  assert.equal(isSafeNotebookPayload("delete-sources", { sourceIds: [], deleteAll: true }), true);
});

test("Notebook bridge validates remote media limits and MIME", () => {
  const valid = { fileName: "video.mp4", type: "video/mp4", size: 10 * 1024 * 1024 };
  assert.equal(isSafeNotebookPayload("prepare-remote-media-source", valid), true);
  assert.equal(isSafeNotebookPayload("prepare-remote-media-source", { ...valid, size: 201 * 1024 * 1024 }), false);
  assert.equal(isSafeNotebookPayload("prepare-remote-media-source", { ...valid, type: "text/html" }), false);
});

test("Notebook bridge bounds source lists", () => {
  const ids = Array.from({ length: 51 }, (_, index) => `source_${String(index).padStart(3, "0")}`);
  assert.equal(isSafeNotebookPayload("extract-existing-sources", { sourceIds: ids }), false);
  assert.equal(isSafeNotebookPayload("extract-existing-sources", { skipSourceIds: ["source_001"] }), true);
});
