import { MAX_ROWS, newRow, parseTsv, providerForUrl, serializeTsv, rowIssue, type RecordRow } from "@/lib/recordWorkspace";
import { WorkspaceClient } from "./workspaceClient";
const HEIGHT = 72;
const fields = ["displayId", "url", "transcript", "translation"] as const;
type Cell = { row: number; col: number };
export class RecordGrid {
  readonly selected = new Set<string>();
  private anchor: Cell = { row: 0, col: 0 };
  private focus: Cell = { row: 0, col: 0 };
  private dragging = false;
  private editor?: HTMLInputElement;
  private viewport: HTMLElement;
  private body: HTMLElement;
  private head: HTMLElement;
  private widths: number[];
  private disposed = false;
  private observer: ResizeObserver;
  constructor(readonly host: HTMLElement, readonly store: WorkspaceClient, readonly busy: () => boolean, readonly report: (text: string) => void) {
    this.widths = [...store.state.widths];
    host.classList.add("nr-grid"); host.setAttribute("role", "grid"); host.setAttribute("aria-label", "视频转录记录表"); host.tabIndex = 0;
    host.innerHTML = '<div class="nr-grid-scroll"><div class="nr-grid-head" role="row"></div><div class="nr-grid-body"></div></div>';
    this.viewport = host.querySelector(".nr-grid-scroll")!; this.head = host.querySelector(".nr-grid-head")!; this.body = host.querySelector(".nr-grid-body")!;
    this.head.innerHTML = '<label><input type="checkbox" aria-label="全选记录"></label>' + ["ID（可留空）", "视频链接 · Drive / Facebook", "原文转录", "中文翻译"].map((name, i) => `<div role="columnheader">${name}<span class="nr-resize" data-resize="${i}" title="拖动调整列宽"></span></div>`).join("");
    this.head.querySelector("input")!.addEventListener("change", (event) => {
      this.selected.clear(); if ((event.target as HTMLInputElement).checked) store.state.rows.forEach((r) => this.selected.add(r.rowId)); this.render();
    });
    this.viewport.addEventListener("scroll", () => this.renderRows());
    host.addEventListener("pointerdown", (event) => this.pointer(event));
    host.addEventListener("pointerover", (event) => {
      if (!this.dragging) return; const cell = (event.target as Element).closest<HTMLElement>("[data-cell]");
      if (cell) { this.focus = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) }; this.highlight(); }
    });
    document.addEventListener("pointerup", this.endDrag);
    host.addEventListener("dblclick", (event) => {
      const cell = (event.target as Element).closest<HTMLElement>("[data-cell]");
      if (!cell) return; this.focus = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) }; this.openCell();
    });
    host.addEventListener("keydown", (event) => this.key(event));
    host.addEventListener("copy", (event) => {
      if (this.editor || (event.target as Element).closest("dialog")) return;
      event.preventDefault(); event.clipboardData?.setData("text/plain", this.copyText());
    });
    host.addEventListener("paste", (event) => {
      if ((event.target as Element).closest("dialog")) return;
      const text = event.clipboardData?.getData("text/plain"); if (text === undefined) return;
      if (this.editor && !/[\t\n]/.test(text)) return;
      event.preventDefault(); if (this.editor) this.editor.dataset.cancelled = "true";
      this.editor?.blur(); this.editor = undefined;
      void this.paste(text).catch((e) => this.report(e.message));
    });
    this.observer = new ResizeObserver(() => this.renderRows()); this.observer.observe(this.viewport); this.render();
  }
  private endDrag = () => { this.dragging = false; };
  private template() { return `32px ${this.widths.map((w) => `${w}px`).join(" ")}`; }
  render() {
    if (this.disposed) return;
    for (const id of this.selected) if (!this.store.state.rows.some((r) => r.rowId === id)) this.selected.delete(id);
    if (!this.editor) this.widths = [...this.store.state.widths];
    this.head.style.gridTemplateColumns = this.template();
    const checkbox = this.head.querySelector<HTMLInputElement>("input")!;
    checkbox.checked = this.store.state.rows.length > 0 && this.selected.size === this.store.state.rows.length;
    checkbox.indeterminate = this.selected.size > 0 && !checkbox.checked;
    this.host.setAttribute("aria-rowcount", String(this.store.state.rows.length + 1));
    this.renderRows();
  }
  private renderRows() {
    if (this.editor || this.disposed) return;
    const rows = this.store.state.rows, count = Math.min(MAX_ROWS, rows.length + 1);
    const start = Math.max(0, Math.floor((this.viewport.scrollTop - 34) / HEIGHT) - 3);
    const end = Math.min(count, start + Math.ceil((this.viewport.clientHeight || 360) / HEIGHT) + 7);
    this.body.style.height = `${count * HEIGHT}px`; this.body.style.width = `${32 + this.widths.reduce((a,b) => a+b, 0)}px`;
    this.body.replaceChildren();
    for (let index = start; index < end; index++) {
      const row = rows[index], element = document.createElement("div"); element.className = "nr-row"; element.setAttribute("role", "row");
      element.style.top = `${index * HEIGHT}px`; element.style.gridTemplateColumns = this.template();
      const label = document.createElement("label"), check = document.createElement("input"); check.type = "checkbox"; check.disabled = !row;
      check.checked = Boolean(row && this.selected.has(row.rowId)); check.setAttribute("aria-label", `选择第 ${index + 1} 行`);
      check.addEventListener("change", () => { if (!row) return; check.checked ? this.selected.add(row.rowId) : this.selected.delete(row.rowId); this.render(); });
      label.append(check); element.append(label);
      for (let col = 0; col < 4; col++) {
        const cell = document.createElement("div"); cell.className = "nr-cell"; cell.dataset.cell = ""; cell.dataset.row = String(index); cell.dataset.col = String(col); cell.setAttribute("role", "gridcell");
        const text = document.createElement("span"); text.className = "nr-cell-text";
        text.textContent = row?.[fields[col]] || (col === 0 ? "ID（可留空）" : col === 1 ? "粘贴 Drive 或 Facebook 链接" : "");
        if (!row?.[fields[col]]) text.classList.add("nr-placeholder"); cell.append(text);
        if (row) {
          const note = col === 1 ? rowIssue(row) || row.note : col === 2 ? row.error : col === 3 ? row.translationError : row.registrationError;
          if (note) { cell.classList.add("nr-note"); cell.title = note; cell.dataset.note = note; }
          if (col < 2 && row.locked) cell.classList.add("nr-locked");
          if ((col === 2 && row.phase === "working") || (col === 3 && row.translationPhase === "working")) {
            const status = document.createElement("small"); status.textContent = col === 2 ? row.note || "处理中…" : "翻译中…"; status.className = "nr-working"; cell.append(status);
          }
          if (col === 0 && row.registeredKey) { const badge = document.createElement("small"); badge.textContent = "已登记"; badge.className = "nr-receipt"; cell.append(badge); }
        }
        element.append(cell);
      }
      this.body.append(element);
    }
    this.highlight();
  }
  private pointer(event: PointerEvent) {
    const handle = (event.target as Element).closest<HTMLElement>("[data-resize]");
    if (handle) {
      event.preventDefault(); const col = Number(handle.dataset.resize), x = event.clientX, width = this.widths[col];
      handle.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent) => { this.widths[col] = Math.max(90, Math.min(1200, width + e.clientX - x)); this.head.style.gridTemplateColumns = this.template(); this.renderRows(); };
      const end = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end); void this.store.command({ type: "widths", widths: [...this.widths] }).catch((e) => this.report(e.message)); };
      handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end); return;
    }
    if ((event.target as Element).closest("input")) return;
    const cell = (event.target as Element).closest<HTMLElement>("[data-cell]"); if (!cell) return;
    event.preventDefault(); this.host.focus({ preventScroll: true });
    this.focus = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
    if (!event.shiftKey) this.anchor = { ...this.focus }; this.dragging = true; this.highlight();
  }
  private bounds() { return { r0: Math.min(this.anchor.row, this.focus.row), r1: Math.max(this.anchor.row, this.focus.row), c0: Math.min(this.anchor.col, this.focus.col), c1: Math.max(this.anchor.col, this.focus.col) }; }
  private highlight() {
    const b = this.bounds(); this.body.querySelectorAll<HTMLElement>("[data-cell]").forEach((cell) => {
      const row = Number(cell.dataset.row), col = Number(cell.dataset.col);
      cell.classList.toggle("nr-selected", row >= b.r0 && row <= b.r1 && col >= b.c0 && col <= b.c1);
    });
  }
  copyText() {
    const b = this.bounds(); return serializeTsv(this.store.state.rows.slice(b.r0, b.r1 + 1).map((r) => fields.slice(b.c0, b.c1 + 1).map((f) => String(r[f] || ""))));
  }
  private key(event: KeyboardEvent) {
    if (this.editor || (event.target as Element).closest("dialog,input")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault(); this.anchor = { row: 0, col: 0 }; this.focus = { row: Math.max(0, this.store.state.rows.length - 1), col: 3 }; this.highlight(); return;
    }
    const moves = { ArrowDown: [1,0], ArrowUp: [-1,0], ArrowLeft: [0,-1], ArrowRight: [0,1], Tab: [0,event.shiftKey ? -1 : 1] };
    if (moves[event.key]) {
      event.preventDefault(); const [r,c] = moves[event.key];
      this.focus = { row: Math.min(this.store.state.rows.length, Math.max(0,this.focus.row+r)), col: Math.max(0,Math.min(3,this.focus.col+c)) };
      if (!event.shiftKey || event.key === "Tab") this.anchor = { ...this.focus };
      const top = this.focus.row * HEIGHT;
      if (top < this.viewport.scrollTop) this.viewport.scrollTop = top;
      if (top + HEIGHT > this.viewport.scrollTop + this.viewport.clientHeight - 34) this.viewport.scrollTop = top + HEIGHT - this.viewport.clientHeight + 34;
      this.renderRows(); return;
    }
    if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); this.openCell(); }
    else if (event.key === "Delete" || event.key === "Backspace") {
      if (this.busy()) { event.preventDefault(); this.report("请先暂停，再编辑记录。"); return; }
      event.preventDefault(); const b = this.bounds();
      const cells: { rowId: string; field: "displayId" | "url"; value: string }[] = [];
      for (const row of this.store.state.rows.slice(b.r0,b.r1+1)) for (let col=b.c0;col<=Math.min(b.c1,1);col++) cells.push({rowId:row.rowId,field:fields[col] as "displayId"|"url",value:""});
      if (cells.length) void this.store.command({type:"edit",cells}).catch((e)=>this.report(e.message));
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); this.openCell(event.key); }
  }
  private openCell(initial?: string) {
    const {row:index,col} = this.focus, row = this.store.state.rows[index];
    if (col > 1) { this.preview(row?.[fields[col]] || "", row ? (col===2?row.error:row.translationError) : ""); return; }
    if (this.busy()) { this.report("请先暂停，再编辑记录。"); return; }
    if (row?.locked) { this.report("该行已开始处理，ID 和链接已锁定。"); return; }
    const cell = this.body.querySelector<HTMLElement>(`[data-row="${index}"][data-col="${col}"]`); if (!cell || this.editor) return;
    const input = document.createElement("input"); this.editor = input; input.value = initial ?? String(row?.[fields[col]] || ""); input.className="nr-editor"; cell.append(input); input.focus(); if (initial===undefined) input.select();
    let cancelled = false;
    input.addEventListener("keydown", (event) => {
      event.stopPropagation(); if (event.key==="Escape") {cancelled=true;input.blur();} else if(event.key==="Enter"||event.key==="Tab") {event.preventDefault();input.blur();this.host.focus();}
    });
    input.addEventListener("blur", () => {
      this.editor=undefined; input.remove();
      if(cancelled || input.dataset.cancelled) {this.render();return;}
      if (!row && !input.value.trim()) { this.render(); return; }
      const work = row ? this.store.command({type:"edit",cells:[{rowId:row.rowId,field:fields[col] as "displayId"|"url",value:input.value}]})
        : this.store.command({type:"add",rows:[newRow(col===0?input.value:"",col===1?input.value:"")]});
      void work.catch((e)=>{this.report(e.message);this.render();});
    },{once:true});
  }
  private async paste(text: string) {
    if (this.busy()) throw new Error("请先暂停，再粘贴记录。");
    const parsed = parseTsv(text); if(!parsed.length)return;
    const start = this.bounds().r0, column = this.bounds().c0;
    if (column > 1) throw new Error("原文和译文为只读列，请在 ID 或视频链接列粘贴。");
    if(start+parsed.length>MAX_ROWS)throw new Error(`表格最多 ${MAX_ROWS} 行，本次粘贴未写入。`);
    const additions: RecordRow[] = [], cells: {rowId:string;field:"displayId"|"url";value:string}[]=[];
    parsed.forEach((values,offset)=>{
      const existing=this.store.state.rows[start+offset], row=existing||newRow();
      if(existing?.locked)throw new Error(`第 ${start+offset+1} 行已锁定，本次粘贴未写入。`);
      if(!existing)additions.push(row);
      const singleLink=values.length===1 && providerForUrl(values[0].trim());
      const base=singleLink?1:column;
      values.forEach((value,i)=>{
        const col=base+i;if(col>1)return;
        const field=fields[col] as "displayId"|"url";
        if(existing)cells.push({rowId:row.rowId,field,value}); else row[field]=value.trim();
      });
      if(!existing)row.provider=providerForUrl(row.url);
    });
    if(cells.length || additions.length)await this.store.command({type:"edit",cells,additions});
    this.anchor={row:start,col:column};this.focus={row:start+parsed.length-1,col:Math.min(3,column+parsed[0].length-1)};this.highlight();
  }
  private preview(value: string, note = "") {
    const dialog=document.createElement("dialog");dialog.className="nr-preview";
    const title=document.createElement("strong");title.textContent=note||"完整内容（只读）";
    const area=document.createElement("textarea");area.readOnly=true;area.value=value;
    const close=document.createElement("button");close.textContent="关闭";close.onclick=()=>dialog.close();
    dialog.append(title,area,close);this.host.append(dialog);dialog.addEventListener("close",()=>dialog.remove());dialog.showModal();
  }
  dispose(){this.disposed=true;this.observer.disconnect();document.removeEventListener("pointerup",this.endDrag);}
}
