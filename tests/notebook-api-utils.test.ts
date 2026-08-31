import test from "node:test";
import assert from "node:assert/strict";
import * as utils from "../src/lib/notebookApi";

const PROJECT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SOURCE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const BLOB_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

test("batchexecute parser reads length-prefixed chunks and reports malformed lines", () => {
  const errors: Array<{ error: Error; line: string }> = [];
  const chunks = utils.parseBatchexecuteChunks(")]}'\n12\n[[\"ok\"]]\n{bad json}\n", (error, line) => {
    errors.push({ error, line });
  });
  assert.deepEqual(chunks, [[["ok"]]]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, "{bad json}");
});

test("extractRpcPayload returns the matching decoded RPC payload", () => {
  const encoded = JSON.stringify([["wrb.fr", "rpc123", JSON.stringify(["value", 7])]]);
  assert.deepEqual(utils.extractRpcPayload(`)]}'\n${encoded.length}\n${encoded}\n`, "rpc123"), ["value", 7]);
  assert.throws(() => utils.extractRpcPayload(encoded, "missing"), /No wrb\.fr payload/);
});

test("findSourceEntry returns the parent source row instead of the nested id tuple", () => {
  const entry = [[SOURCE_ID], "audio.mp3", ["audio/mpeg", BLOB_ID], [null, 2]];
  assert.equal(utils.findSourceEntry([PROJECT_ID, [entry]], SOURCE_ID), entry);
});

test("source status distinguishes ready and failed states", () => {
  const ready = utils.summarizeSourceStatus([[SOURCE_ID], "audio.mp3", ["audio/mpeg", BLOB_ID], [null, 2]]);
  const failed = utils.summarizeSourceStatus([[SOURCE_ID], "audio.mp3", [null, 3]]);
  assert.equal(ready.ready, true);
  assert.equal(ready.failed, false);
  assert.equal(failed.ready, false);
  assert.equal(failed.failed, true);
});

test("extractSourceRecords applies visible names while keeping stable source ids", () => {
  const entry = [[SOURCE_ID], "internal-name.mp3", ["audio/mpeg", BLOB_ID], [null, 2]];
  const records = utils.extractSourceRecords([PROJECT_ID, [entry]], PROJECT_ID, ["界面名称.mp3"]);
  assert.deepEqual(records, [{ sourceId: SOURCE_ID, sourceName: "界面名称.mp3" }]);
});

test("extractTranscriptText keeps timed text and removes metadata and duplicates", () => {
  const payload = [
    [0, 1000, ["第一句", "第一句", SOURCE_ID, "audio/mpeg"]],
    [1000, 2000, ["第二句\n", PROJECT_ID]]
  ];
  const transcript = utils.extractTranscriptText(payload, {
    sourceId: SOURCE_ID,
    projectId: PROJECT_ID,
    fileName: "audio.mp3"
  });
  assert.equal(transcript, "第一句\n第二句");
});

test("upload retry classification and source option payload stay compatible", () => {
  assert.equal(utils.isRetryableUploadError({ debug: { status: 503 } }), true);
  assert.equal(utils.isRetryableUploadError({ debug: { status: 400 } }), false);
  assert.deepEqual(utils.sourceOptions(), [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]]);
});
