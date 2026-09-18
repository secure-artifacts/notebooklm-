import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { PipelineOptions } from "../src/scopes/content/workspacePipeline";
// Vite resolves this package's `module` entry; Node otherwise chooses its missing `main`.
registerHooks({ resolve(specifier, context, next) {
  return next(specifier === "@webextkits/storage-local" ? new URL("../node_modules/@webextkits/storage-local/dist/index.js", import.meta.url).href : specifier, context);
} });
Object.assign(globalThis, { window: { addEventListener() {}, setInterval, clearInterval } });
const { WorkspacePipeline } = await import("../src/scopes/content/workspacePipeline");
const { extensionClient } = await import("../src/scopes/content/extensionClient");
const { FacebookImportCoordinator } = await import("../src/scopes/content/facebookCoordinator");
import { applyWorkspaceCommand, emptyWorkspace, newRow, taskComplete, registrationKey, sheetTarget, type RecordRow } from "../src/lib/recordWorkspace";

const urlA = "https://docs.google.com/spreadsheets/d/sheetA/edit?gid=0";
const urlB = "https://docs.google.com/spreadsheets/d/sheetB/edit#gid=0";
test("retry does not trust an old receipt after a later registration failure", async () => {
  const row = { ...oldDrive(), sourceDeleted: false, translation: "中文", requirements: { ...options, autoRegister: true }, registrationError: "failed" };
  row.registeredKey = await registrationKey(row, urlA);
  row.registeredTarget = sheetTarget(urlA);
  const { p, store, calls } = setup([row]); let sent = 0;
  const original = extensionClient.upsertSheet;
  extensionClient.upsertSheet = async () => { sent++; return { ok: true, data: { results: [{ index: 0, success: true }] } }; };
  try { await p.run(options, ["old"]); } finally { extensionClient.upsertSheet = original; }
  assert.equal(sent, 1); assert.equal(store.row("old").registrationError, "");
  assert.ok(calls.includes("delete-sources"));
});
const options: PipelineOptions = { translate: true, autoDelete: true, autoRegister: false, databaseUrl: urlA, batchSize: 10, translationBatch: 5 };
test("cleared draft rows do not block a remaining valid import",async()=>{
 const {p,store,calls}=setup([newRow(),fb()]);await p.run(options);
 assert.ok(calls.includes("facebook:new"));assert.equal(store.row('new').taskDone,true);
});
test("conflicting sheet receipts never permit automatic deletion",async()=>{
 const row={...oldDrive(),sourceDeleted:false,translation:'中文',requirements:{...options,autoRegister:true}};
 const {p,store,calls}=setup([row]);const original=extensionClient.upsertSheet;
 extensionClient.upsertSheet=async()=>({ok:true,data:{summary:{success:1,failed:0},results:[{index:0,post_id:'other',success:true}]}});
 try{await p.run(options);}finally{extensionClient.upsertSheet=original;}
 assert.ok(store.row('old').registrationError);assert.ok(!calls.includes('delete-sources'));
});
function setup(rows: RecordRow[]) {
  Object.assign(globalThis, { window: { setInterval, clearInterval }, location: { pathname: "/notebook/test" } });
  const store: any = { notebookId: "test", state: { ...emptyWorkspace("test"), rows }, row(id: string) { return this.state.rows.find((r) => r.rowId === id); },
    async command(command) { this.state = applyWorkspaceCommand(this.state, command, 1); } };
  const p: any = Object.create(WorkspacePipeline.prototype);
  Object.assign(p, { store, panel: {}, busy: false, paused: false, render() {}, report(message) { reports.push(message); } });
  const calls: string[] = [], reports: string[] = [];
  p.api = async (action, payload) => {
    calls.push(action);
    if (action === "get-source-summary") return { totalSources: 0 };
    if (action === "delete-sources") return { deleted: payload.sourceIds };
    throw new Error(`Unexpected ${action}`);
  };
  p.facebook = async (ids: string[]) => {
    calls.push(`facebook:${ids.join(",")}`);
    for (const id of ids) await p.patch(id, { transcript: store.row(id).transcript || "new original", sourceId: `source-${id}`, sourceDeleted: false, phase: "done", error: "" });
  };
  p.driveRow = async (id: string) => {
    calls.push(`drive:${id}`);
    await p.patch(id, { transcript: store.row(id).transcript || "drive original", sourceId: `source-${id}`, sourceDeleted: false, phase: "done", error: "" });
  };
  p.translate = async (records, _panel, _paused, checkpoint) => {
    calls.push(`translate:${records.map((r) => r.rowId).join(",")}`);
    for (const r of records) await checkpoint(r.rowId, "完整中文");
    return new Map(records.map((r) => [r.rowId, "完整中文"]));
  };
  p.validateRegistration = async () => undefined;
  return { p, store, calls, reports };
}
function oldDrive() {
  return { ...newRow("old", "https://drive.google.com/file/d/1234567890abc/view", "old"), locked: true, phase: "done" as const, transcript: "保留原文", sourceId: "old-source", sourceDeleted: true };
}
function fb() { return newRow("new", "https://www.facebook.com/reel/123456789012345", "new"); }

test("legacy removed Drive row does not block a new Facebook import with AI on", async () => {
  const { p, store, calls } = setup([oldDrive(), fb()]);
  await p.run(options);
  assert.ok(calls.includes("facebook:new")); assert.ok(calls.includes("translate:new"));
  assert.ok(!calls.includes("drive:old")); assert.equal(store.row("old").translation, undefined);
  assert.equal(store.row("new").taskDone, true);
});
test("explicit retry reimports a removed source for translation without losing original", async () => {
  const { p, store, calls } = setup([oldDrive(), fb()]);
  await p.run(options, ["old"]);
  assert.ok(calls.includes("drive:old")); assert.ok(calls.includes("translate:old"));
  assert.ok(!calls.includes("facebook:new")); assert.equal(store.row("old").transcript, "保留原文");
  assert.equal(store.row("old").translation, "完整中文");
});
test("turning AI on later does not change a completed task or deletion eligibility", async () => {
  const { p, store, calls } = setup([fb()]);
  await p.run({ ...options, translate: false });
  assert.equal(taskComplete(store.row("new")), true); assert.equal(store.row("new").requirements.translate, false);
  calls.length = 0; await p.run(options);
  assert.deepEqual(calls, []); assert.equal(taskComplete(store.row("new")), true);
});
test("turning AI off does not downgrade an unfinished AI task", async () => {
  const row = { ...oldDrive(), sourceDeleted: false, requirements: { ...options }, taskDone: false };
  const { p, store, calls } = setup([row]);
  assert.equal(taskComplete(row), false);
  await p.run({ ...options, translate: false });
  assert.ok(calls.includes("translate:old")); assert.equal(store.row("old").translation, "完整中文");
});
test("completed selected rows are not downloaded or translated again", async () => {
  const row = { ...oldDrive(), translation: "已有中文", requirements: { ...options }, taskDone: true };
  const { p, calls } = setup([row]); await p.run(options, ["old"]);
  assert.ok(!calls.some((c) => /^(drive|facebook|translate):/.test(c)));
});
test("busy lock is acquired before async storage claim and survives failed claim", async () => {
  const { p, store } = setup([]); let release!: () => void; let count = 0;
  const original = store.command.bind(store);
  store.command = async (command) => { if (command.type === "claim") await new Promise<void>((resolve) => { release = resolve; }); return original(command); };
  const first = p.execute(async () => { count++; });
  assert.equal(p.busy, true); await p.execute(async () => { count++; }); release(); await first;
  assert.equal(count, 1); assert.equal(p.busy, false);
  store.command = async () => { throw new Error("claim failed"); };
  await p.execute(async () => { count++; }); assert.equal(count, 1); assert.equal(p.busy, false);
});
test("pause after translation saves text without starting registration or deletion", async () => {
  const { p, store, calls } = setup([{ ...oldDrive(), sourceDeleted: false, requirements: { ...options, autoRegister: true } }]);
  p.translate = async (records, _panel, _paused, checkpoint) => { await checkpoint("old", "已完成译文"); p.pause(); return new Map([["old", "已完成译文"]]); };
  await p.run(options);
  assert.equal(store.row("old").translation, "已完成译文"); assert.equal(store.row("old").sourceDeleted, false);
  assert.ok(!calls.includes("delete-sources")); assert.notEqual(store.row("old").taskDone, true);
});
test("registration receipt distinguishes spreadsheet and gid, ignoring URL decorations", async () => {
  const row = oldDrive();
  assert.notEqual(await registrationKey(row, urlA), await registrationKey(row, urlB));
  assert.notEqual(await registrationKey(row, urlA), await registrationKey(row, urlA.replace("gid=0", "gid=1")));
  assert.equal(await registrationKey(row, urlA), await registrationKey(row, "https://docs.google.com/spreadsheets/d/sheetA/edit#gid=0"));
});
test("registration failure is not deletable success; retry submits only registration", async () => {
  const row = { ...oldDrive(), translation: "中文", requirements: { ...options, autoRegister: true }, registrationError: "failed" };
  const { p, store, calls } = setup([row]); assert.equal(taskComplete(row), false);
  const original = extensionClient.upsertSheet;
  extensionClient.upsertSheet = async () => ({ ok: true, data: { results: [{ index: 0, success: true }] } });
  try { await p.run(options, ["old"]); } finally { extensionClient.upsertSheet = original; }
  assert.ok(!calls.some((c) => /^(drive|translate):/.test(c))); assert.equal(taskComplete(store.row("old")), true);
  assert.equal(store.row("old").registeredTarget, sheetTarget(urlA));
});
test("automatic registration to another target does not reuse old receipt", async () => {
  const row = { ...oldDrive(), translation: "中文" };
  row.registeredKey = await registrationKey(row, urlA);
  const { p, store } = setup([row]); let sent = 0; const original = extensionClient.upsertSheet;
  extensionClient.upsertSheet = async () => { sent++; return { ok: true, data: { results: [{ index: 0, success: true }] } }; };
  try { await p.registerRows(["old"], urlB, true); await p.registerRows(["old"], urlB, true); } finally { extensionClient.upsertSheet = original; }
  assert.equal(sent, 1); assert.equal(store.row("old").registeredTarget, sheetTarget(urlB));
});
test("sequential Drive then Facebook respects independent task snapshots", async () => {
  const row = newRow("drive", "https://drive.google.com/file/d/1234567890abc/view", "drive");
  const { p, store, calls } = setup([row]);
  await p.run({ ...options, translate: false });
  assert.equal(store.row("drive").sourceDeleted, true);
  await store.command({ type: "add", rows: [fb()] }); calls.length = 0;
  await p.run(options);
  assert.ok(calls.includes("facebook:new")); assert.ok(!calls.includes("drive:drive"));
  assert.equal(store.row("drive").requirements.translate, false);
  assert.equal(store.row("new").requirements.translate, true);
});
test("failed reimport preserves the previous original text", async () => {
  const { p, store } = setup([oldDrive()]);
  await store.command({type:"result",rowId:"old",patch:{sourceId:"replacement"}});
  await p.extracted("old", { sourceId: "replacement", sourceName: "old.mp4", transcript: "", error: "download failed" });
  assert.equal(store.row("old").transcript, "保留原文"); assert.equal(taskComplete(store.row("old")), false);
});
test("failed automatic registration retains source and prevents delete-success", async () => {
  const row = { ...oldDrive(), sourceDeleted: false, translation: "中文", requirements: { ...options, autoRegister: true } };
  const { p, store, calls } = setup([row]); const original = extensionClient.upsertSheet;
  extensionClient.upsertSheet = async () => ({ ok: false, error: { message: "service failed" } });
  try { await p.run(options); } finally { extensionClient.upsertSheet = original; }
  assert.equal(store.row("old").sourceDeleted, false); assert.equal(taskComplete(store.row("old")), false);
  assert.ok(!calls.includes("delete-sources")); assert.equal(p.busy, false);
});
test("missing Colab leaves rows unstarted and normal Start works after backend starts", async () => {
  const { p, store, calls, reports } = setup([fb()]);
  delete p.facebook;
  const lookup = extensionClient.findReusableColabRuntime;
  const start = FacebookImportCoordinator.prototype.start;
  extensionClient.findReusableColabRuntime = async () => null;
  try {
    await p.run(options);
    assert.equal(store.row("new").phase, "pending");
    assert.equal(store.row("new").locked, false);
    assert.equal(store.row("new").error, "");
    assert.equal(store.row("new").requirements, undefined);
    assert.ok(reports.some((r) => r.includes("未启动 Colab")));
    FacebookImportCoordinator.prototype.start = async function(tasks) {
      await (this as any).hooks.onBatchAccepted();
      assert.equal(store.row("new").locked, true);
      return tasks.map((t) => ({ sourceId: "source-new", sourceName: t.postId, transcript: "原文" }));
    };
    await p.run(options);
    assert.equal(store.row("new").taskDone, true);
    assert.ok(calls.includes("translate:new"));
  } finally { extensionClient.findReusableColabRuntime = lookup; FacebookImportCoordinator.prototype.start = start; }
});
test("Start repairs only legacy missing-backend failures, not actual media failures", async () => {
  const unstarted = { ...fb(), locked: true, phase: "failed" as const, error: "未启动 Colab 临时后端。请启动后端。" };
  const failed = { ...fb(), rowId: "real-failure", phase: "failed" as const, error: "HTTP 429" };
  const { p, store, calls } = setup([unstarted, failed]);
  await p.run(options);
  assert.ok(calls.includes("facebook:new"));
  assert.ok(!calls.includes("facebook:real-failure"));
  assert.equal(store.row("real-failure").error, "HTTP 429");
  assert.equal(store.row("new").taskDone, true);
});
