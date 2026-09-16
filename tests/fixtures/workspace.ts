import { WorkspaceApp } from "../../src/scopes/content/workspaceApp";
import { extensionClient } from "../../src/scopes/content/extensionClient";
import { loadWorkspace, changeWorkspace } from "../../src/scopes/background/recordWorkspaceStore";
import { newRow, mergeWorkspaceChange } from "../../src/lib/recordWorkspace";
import type { PanelSettings } from "../../src/types/messages";

const report = document.querySelector("#test-report")!;
let checks = 0;
function assert(ok: unknown, message: string) { if (!ok) throw new Error(message); checks++; }
async function rejects(work: () => Promise<unknown>, message: string) { let failed = false; try { await work(); } catch { failed = true; } assert(failed, message); }
async function storageTests() {
  const id = crypto.randomUUID(); let state = await loadWorkspace(id);
  const rows = Array.from({ length: 1000 }, (_, i) => newRow(`test-${i}`, "https://www.facebook.com/reel/123456789012345", `r-${i}`));
  state = mergeWorkspaceChange(state, await changeWorkspace(id, state.revision, { type: "add", rows }, 1));
  assert((await loadWorkspace(id)).rows.length === 1000, "1000 rows persist");
  const delta = await changeWorkspace(id, state.revision, { type: "result", rowId: "r-400", patch: { transcript: "原文\n".repeat(3000), locked: true } }, 1);
  assert(delta.upserts.length === 1, "only one changed row is transmitted");
  await rejects(() => changeWorkspace(id, state.revision, { type: "delete", rowIds: ["r-0"] }, 1), "stale revision rejected");
  state = mergeWorkspaceChange(state, delta);
  await rejects(() => changeWorkspace(id, state.revision, { type: "edit", cells: [{ rowId: "r-400", field: "displayId", value: "changed" }] }, 1), "locked ID rejected");
  state = mergeWorkspaceChange(state, await changeWorkspace(id, state.revision, { type: "claim" }, 1));
  await rejects(() => changeWorkspace(id, state.revision, { type: "claim" }, 2), "other tab rejected");
  state = mergeWorkspaceChange(state, await changeWorkspace(id, state.revision, { type: "release" }, 1));
  state = mergeWorkspaceChange(state, await changeWorkspace(id, state.revision, { type: "delete", rowIds: state.rows.map((r) => r.rowId) }, 1));
  assert((await loadWorkspace(id)).rows.length === 0, "clear survives reload without legacy resurrection");
}
try {
  await storageTests();
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  let saved = await loadWorkspace(id);
  if (!localStorage.getItem("workspace-fixture-initialized")) {
    const rows = Array.from({ length: 1000 }, (_, i) => {
      const row = newRow(i < 2 ? "" : `video_${i}`, i % 2 ? "https://www.facebook.com/reel/123456789012345" : "https://drive.google.com/file/d/1234567890abcdef/view");
      if (i >= 2) { row.locked = true; row.transcript = "မင်္ဂလာပါ။ 原始转录正文，长文完整保留。\n".repeat(30); row.phase = "done"; }
      if (i >= 3) { row.translation = "这是一段完整的简体中文翻译，用于验证单元格展示、拖动列宽和复制全文。\n".repeat(30); row.translationPhase = "done"; }
      if (i === 2) row.translationError = "翻译超时，原文和来源已保留，选中本行可重试。";
      return row;
    });
    await changeWorkspace(id, saved.revision, { type: "add", rows }, 1); localStorage.setItem("workspace-fixture-initialized", "1");
  }
  let panel: PanelSettings = { aiTranslationEnabled:true, aiTranslationBatchSize:5, autoDeleteImported:true, autoRegisterImported:false, driveBatchSize:10, importMode:"drive",facebookImportOpen:false,facebookAutoRegister:false,minimized:false,layout:{width:1100,height:760,left:24,top:24} };
  Object.assign(extensionClient, {
    getSettings: async () => ({ panel, databaseUrl:"",deploymentConfigured:false,deploymentUrl:"" }),
    savePanelSettings: async (value: PanelSettings) => {panel=value;}, saveDatabaseUrl: async () => undefined,
    getExtensionResources: () => ({iconUrl:"/assets/icon-128.png",extensionOrigin:location.origin,driveLoaderUrl:"/unused"}),
    loadWorkspace, changeWorkspace: (id,rev,command) => changeWorkspace(id,rev,command,1),
    upsertSheet: async () => { throw new Error("测试页面禁止外部登记"); },
    findReusableColabRuntime: async () => { throw new Error("测试页面禁止调用 Colab"); }
  });
  const app = new WorkspaceApp(id); await app.mount();
  assert(document.querySelectorAll(".nr-row").length < 30, "1000 rows are virtualized");
  assert(document.querySelector<HTMLElement>(".nr-grid")!.clientHeight > 150, "grid receives available height");
  report.textContent = `PASS：${checks} 项浏览器检查通过 · 1000 行 / 虚拟渲染 · 本地隔离测试，不调用外部服务`;
} catch (error) { report.textContent = `FAIL：${error.message}\n${error.stack}`; (report as HTMLElement).style.background="#a32840"; }
