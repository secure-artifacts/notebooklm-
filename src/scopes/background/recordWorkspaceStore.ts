import { MAX_ROWS, applyWorkspaceCommand, migrateLegacyJob, type RecordRow, type Workspace, type WorkspaceChange, type WorkspaceCommand } from "@/lib/recordWorkspace";
import { loadFacebookJob } from "./facebookJobStore";

type Metadata = Omit<Workspace, "rows"> & { rowIds: string[] };
type StoredRow = { notebookId: string; rowId: string; row: RecordRow };
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("nlmRecordWorkspaces", 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains("workspaces")) r.result.createObjectStore("workspaces", { keyPath: "notebookId" });
      if (!r.result.objectStoreNames.contains("rowData")) r.result.createObjectStore("rowData", { keyPath: ["notebookId", "rowId"] });
    };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
function validate(id: string) { if (!/^[0-9a-f-]{20,80}$/i.test(id)) throw new Error("笔记本编号无效"); }
function metadata(state: Workspace): Metadata {
  const { rows, ...meta } = state; return { ...meta, rowIds: rows.map((r) => r.rowId) };
}
export async function loadWorkspace(notebookId: string): Promise<Workspace> {
  validate(notebookId);
  const legacy = migrateLegacyJob(notebookId, await loadFacebookJob(notebookId)), db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["workspaces", "rowData"], "readwrite"), metaStore = tx.objectStore("workspaces"), rows = tx.objectStore("rowData");
    const request = metaStore.get(notebookId); let result: Workspace;
    request.onsuccess = () => {
      const stored = request.result as Metadata | Workspace | undefined;
      if (!stored || "rows" in stored) {
        result = (stored as Workspace) || legacy;
        metaStore.put(metadata(result));
        for (const row of result.rows) rows.put({ notebookId, rowId: row.rowId, row });
      } else {
        const { rowIds, ...meta } = stored;
        result = { ...meta, rows: new Array(rowIds.length) };
        rowIds.forEach((id, index) => {
          const r = rows.get([notebookId, id]);
          r.onsuccess = () => { if (!r.result) { tx.abort(); return; } result.rows[index] = (r.result as StoredRow).row; };
        });
      }
    };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("记录读取失败，未修改原记录。")); };
  });
}
export async function changeWorkspace(notebookId: string, revision: number, command: WorkspaceCommand, tabId: number): Promise<WorkspaceChange> {
  validate(notebookId); const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["workspaces", "rowData"], "readwrite"), metaStore = tx.objectStore("workspaces"), rows = tx.objectStore("rowData");
    const request = metaStore.get(notebookId); let result: WorkspaceChange; let failure: unknown;
    const fail = (error: unknown) => { failure = error; tx.abort(); };
    request.onsuccess = () => {
      try {
        const meta = request.result as Metadata;
        if (!meta || meta.revision !== revision || !meta.rowIds) throw new Error("记录已在其他页面更新，请刷新后继续。当前修改未覆盖已有数据。");
        const additions = command.type === "add" ? command.rows : command.type === "edit" ? command.additions || [] : [];
        if (additions.length && meta.rowIds.length + additions.length > MAX_ROWS) throw new Error(`表格最多 ${MAX_ROWS} 行`);
        const known = new Set(meta.rowIds);
        for (const row of additions) { if (known.has(row.rowId)) throw new Error("记录编号重复"); known.add(row.rowId); }
        const needed = command.type === "result" ? [command.rowId] : command.type === "edit" ? [...new Set(command.cells.map((c) => c.rowId))].filter((id) => !additions.some((r) => r.rowId === id)) : [];
        const loaded: RecordRow[] = []; let remaining = needed.length;
        const commit = () => {
          try {
            const next = applyWorkspaceCommand({ ...meta, rows: loaded }, command, tabId);
            const deleted = command.type === "delete" ? command.rowIds : [];
            const remove = new Set(deleted);
            const rowIds = [...meta.rowIds.filter((id) => !remove.has(id)), ...additions.map((r) => r.rowId)];
            const { rows: upserts, ...values } = next;
            metaStore.put({ ...values, rowIds });
            for (const row of upserts) rows.put({ notebookId, rowId: row.rowId, row });
            for (const id of deleted) rows.delete([notebookId, id]);
            result = { revision: next.revision, widths: next.widths, lease: next.lease, upserts, deleted };
          } catch (error) { fail(error); }
        };
        if (!remaining) commit();
        else for (const id of needed) {
          const r = rows.get([notebookId, id]);
          r.onsuccess = () => {
            if (!r.result) { fail(new Error("记录已不存在，请刷新后继续。")); return; }
            loaded.push((r.result as StoredRow).row); if (!--remaining) commit();
          };
        }
      } catch (error) { fail(error); }
    };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = () => { db.close(); reject(failure || tx.error); };
  });
}
