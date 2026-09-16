import { emptyWorkspace, mergeWorkspaceChange, type Workspace, type WorkspaceCommand } from "@/lib/recordWorkspace";
import { extensionClient } from "./extensionClient";
export class WorkspaceClient {
  state: Workspace;
  private tail: Promise<unknown> = Promise.resolve();
  onChange: () => void = () => undefined;
  constructor(readonly notebookId: string) { this.state = emptyWorkspace(notebookId); }
  async load() { this.state = await extensionClient.loadWorkspace(this.notebookId); this.onChange(); }
  command(command: WorkspaceCommand): Promise<void> {
    const work = this.tail.then(async () => {
      this.state = mergeWorkspaceChange(this.state, await extensionClient.changeWorkspace(this.notebookId, this.state.revision, command)); this.onChange();
    });
    this.tail = work.catch(() => undefined); return work;
  }
  row(id: string) {
    const row = this.state.rows.find((row) => row.rowId === id);
    if (!row) throw new Error("记录已不存在"); return row;
  }
}
