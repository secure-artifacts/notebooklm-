import { WorkspaceClient } from "./workspaceClient";
import { WorkspacePipeline, type PipelineOptions } from "./workspacePipeline";
import { RecordGrid } from "./recordGrid";
import { extensionClient } from "./extensionClient";
import { taskComplete, serializeTsv } from "@/lib/recordWorkspace";
import type { PanelSettings } from "@/types/messages";
import "./workspace.css";

const ID="nlm-video-translation-helper";
export function bootWorkspaceApp() {
  let current="", app: WorkspaceApp|undefined;
  const sync=()=>{
    const id=location.pathname.match(/^\/notebook\/([0-9a-f-]+)\/?$/i)?.[1]||"";
    if(id===current)return;
    app?.dispose();current=id;
    if(id){app=new WorkspaceApp(id);void app.mount().catch((error)=>app?.report(error.message,true));}
  };
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",sync,{once:true});else sync();
  window.setInterval(sync,700);
}
export class WorkspaceApp {
  root=document.createElement("section");
  store:WorkspaceClient;pipeline:WorkspacePipeline;grid?:RecordGrid;settings!:PanelSettings;
  logs:string[]=[];disposed=false;private resize?:ResizeObserver;private saveTimer=0;
  constructor(id:string){this.store=new WorkspaceClient(id);this.pipeline=new WorkspacePipeline(this.store,this.root,(text,error)=>this.report(text,error),()=>this.render());}
  query<T extends HTMLElement=HTMLElement>(name:string){return this.root.querySelector<T>(`[data-role="${name}"]`)!;}
  async mount(){
    this.root.id=ID;this.root.className="nr-panel";
    this.root.innerHTML=`<header><div class="nr-brand"><img alt="" src="${extensionClient.getExtensionResources().iconUrl}"><strong>转录登记</strong></div><label><input type="checkbox" data-role="translate">AI 翻译</label><label>每批 <input data-role="translation-batch" type="number" min="1" max="20" value="5"> 个</label><button data-action="minimize" title="最小化">−</button></header>
      <main><div data-role="alert" role="alert" hidden></div><label class="nr-database">登记表格<input data-role="database" placeholder="含 gid 的 Google 表格链接"></label>
      <div class="nr-grid-slot" data-role="grid"></div>
      <div class="nr-toolbar"><span data-role="count">0 条</span><button data-action="clear">清空表格</button><button data-action="remove-success">删除成功</button><button data-action="retry">重试选中</button><label>导入每批 <input data-role="batch" type="number" min="1" max="20" value="10"></label><button class="nr-primary" data-action="start">开始 / 继续</button><button data-action="pause" hidden>暂停</button></div>
      <small class="nr-help">支持混贴 Drive / Facebook 链接 · 拖动表头边界调整列宽 · 双击查看全文 · ID 在开始处理后锁定</small>
      <div class="nr-options"><label><input type="checkbox" data-role="auto-delete">自动移除来源</label><label><input type="checkbox" data-role="auto-register">自动登记表格</label><span data-role="summary"></span></div>
      <div class="nr-actions"><button data-action="copy">复制结果</button><button data-action="register">登记表格</button></div>
      <div class="nr-toolbar"><button data-action="extract">提取现有来源</button><button data-action="delete-sources">删除已添加的来源</button><span data-role="status">正在加载记录…</span></div>
      <details class="nr-logs"><summary>操作日志</summary><div data-role="logs"></div></details></main>`;
    document.documentElement.append(this.root);
    const saved=await extensionClient.getSettings(); if(this.disposed)return;
    this.settings=saved.panel;
    this.query<HTMLInputElement>("database").value=saved.databaseUrl;
    this.query<HTMLInputElement>("translate").checked=saved.panel.aiTranslationEnabled;
    this.query<HTMLInputElement>("auto-delete").checked=saved.panel.autoDeleteImported;
    this.query<HTMLInputElement>("auto-register").checked=saved.panel.autoRegisterImported;
    this.query<HTMLInputElement>("translation-batch").value=String(saved.panel.aiTranslationBatchSize||5);
    this.query<HTMLInputElement>("batch").value=String(Math.min(20,saved.panel.driveBatchSize||10));
    await this.store.load();if(this.disposed)return;
    // Same tab after reload may release its abandoned lease; another tab is rejected.
    try{await this.store.command({type:"release"});}catch{this.report("此笔记本正在另一标签页处理；此处仅查看。",true);}
    this.grid=new RecordGrid(this.query("grid"),this.store,()=>this.pipeline.busy,(text)=>this.report(text,true));
    this.store.onChange=()=>{if(!this.disposed){this.grid?.render();this.render();}};
    this.bind();this.layout();this.render();this.report(`已恢复 ${this.store.state.rows.length} 条记录。`);
  }
  options():PipelineOptions{
    return{translate:this.query<HTMLInputElement>("translate").checked,autoDelete:this.query<HTMLInputElement>("auto-delete").checked,
      autoRegister:this.query<HTMLInputElement>("auto-register").checked,databaseUrl:this.query<HTMLInputElement>("database").value.trim(),
      translationBatch:Math.max(1,Math.min(20,Number(this.query<HTMLInputElement>("translation-batch").value)||5)),
      batchSize:Math.max(1,Math.min(20,Number(this.query<HTMLInputElement>("batch").value)||10))};
  }
  private bind(){
    this.root.addEventListener("click",(event)=>{
      const button=(event.target as Element).closest<HTMLButtonElement>("[data-action]");if(!button)return;
      void this.action(button.dataset.action!).catch((error)=>this.report(error.message,true));
    });
    for(const role of ["translate","auto-delete","auto-register","batch","translation-batch"]){
      this.query(role).addEventListener("change",()=>{this.render();void this.saveSettings().catch((e)=>this.report(e.message,true));});
    }
    this.query("database").addEventListener("change",()=>{void extensionClient.saveDatabaseUrl(this.options().databaseUrl).catch((e)=>this.report(e.message,true));});
    const header=this.root.querySelector("header")!;
    header.addEventListener("pointerdown",(event)=>{
      if((event.target as Element).closest("button,input,label"))return;
      const rect=this.root.getBoundingClientRect(),x=event.clientX,y=event.clientY;header.setPointerCapture(event.pointerId);
      const move=(e:PointerEvent)=>{this.root.style.left=`${Math.max(0,Math.min(innerWidth-this.root.offsetWidth,rect.left+e.clientX-x))}px`;this.root.style.top=`${Math.max(0,Math.min(innerHeight-this.root.offsetHeight,rect.top+e.clientY-y))}px`;this.root.style.right="auto";};
      const end=()=>{header.removeEventListener("pointermove",move);header.removeEventListener("pointerup",end);this.persistLayout();};
      header.addEventListener("pointermove",move);header.addEventListener("pointerup",end,{once:true});
    });
    this.resize=new ResizeObserver(()=>{clearTimeout(this.saveTimer);this.saveTimer=window.setTimeout(()=>this.persistLayout(),400);});this.resize.observe(this.root);
  }
  private async action(action:string){
    const ids=()=>this.store.state.rows.map((r)=>r.rowId);
    if(action==="minimize"){this.root.classList.toggle("nr-minimized");return;}
    if(action==="pause"){this.pipeline.pause();return;}
    if(action==="copy"){
      const rows=this.store.state.rows.filter((r)=>r.transcript&&!r.error&&(!this.grid!.selected.size||this.grid!.selected.has(r.rowId)));
      await navigator.clipboard.writeText(serializeTsv(rows.map((r)=>[r.displayId,r.transcript,r.translation||""])));this.report(`已复制 ${rows.length} 条完整结果（ID、原文、中文）`);return;
    }
    if(this.pipeline.busy)return;
    if(action==="start")await this.pipeline.run(this.options());
    else if(action==="retry"){
      if(!this.grid!.selected.size)throw new Error("请勾选要重试的行");
      await this.pipeline.run(this.options(),[...this.grid!.selected]);
    }else if(action==="extract")await this.pipeline.extractExisting(this.options());
    else if(action==="register")await this.pipeline.execute(()=>this.pipeline.registerRows(this.grid!.selected.size?[...this.grid!.selected]:ids(),this.options().databaseUrl));
    else if(action==="clear"||action==="remove-success"){
      const remove=action==="clear"?ids():this.store.state.rows.filter((r)=>taskComplete(r)).map((r)=>r.rowId);
      await this.store.command({type:"delete",rowIds:remove});this.report(`已删除 ${remove.length} 行及其本地正文`);
    }else if(action==="delete-sources"){
      if(window.confirm("删除当前笔记本中的全部来源？表格中已保存的原文和译文会保留。"))await this.pipeline.deleteSources();
    }
  }
  render(){
    if(!this.settings||this.disposed)return;
    const rows=this.store.state.rows,busy=this.pipeline.busy,translate=this.options().translate;
    this.query("count").textContent=`${rows.length} 条`;
    this.query("summary").textContent=`成功 ${rows.filter((r)=>taskComplete(r)).length} · 失败 ${rows.filter((r)=>r.error||r.translationError||r.registrationError).length}`;
    this.root.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button)=>{
      button.disabled=busy&&!["pause","copy","minimize"].includes(button.dataset.action!);
      if(button.dataset.action==="pause"){button.hidden=!busy;button.disabled=this.pipeline.paused;}
    });
    for(const role of ["translate","auto-delete","auto-register","batch","translation-batch","database"])this.query<HTMLInputElement>(role).disabled=busy;
  }
  report(text:string,error=false){
    if(this.disposed)return;
    this.query("status").textContent=text;
    const alert=this.query("alert");alert.hidden=!error;alert.textContent=error?text:"";
    this.logs.unshift(`${new Date().toLocaleTimeString()} ${text}`);this.logs.length=Math.min(100,this.logs.length);
    this.query("logs").replaceChildren(...this.logs.map((text)=>{const el=document.createElement("div");el.textContent=text;return el;}));this.render();
  }
  private async saveSettings(){
    const o=this.options();Object.assign(this.settings,{aiTranslationEnabled:o.translate,aiTranslationBatchSize:o.translationBatch,autoDeleteImported:o.autoDelete,autoRegisterImported:o.autoRegister,driveBatchSize:o.batchSize});
    await extensionClient.savePanelSettings(this.settings);
  }
  private layout(){
    const l=this.settings.layout||{};this.root.style.width=`${Math.max(360,Math.min(l.width||1000,innerWidth-16))}px`;this.root.style.height=`${Math.max(320,Math.min(l.height||760,innerHeight-16))}px`;
    this.root.style.left=`${Math.max(8,Math.min(l.left||24,innerWidth-this.root.offsetWidth-8))}px`;this.root.style.top=`${Math.max(8,Math.min(l.top||24,innerHeight-this.root.offsetHeight-8))}px`;this.root.style.right="auto";
  }
  private persistLayout(){
    if(!this.settings||this.disposed||this.root.classList.contains("nr-minimized"))return;
    const r=this.root.getBoundingClientRect();this.settings.layout={left:r.left,top:r.top,width:r.width,height:r.height};void this.saveSettings().catch(()=>undefined);
  }
  dispose(){this.disposed=true;this.pipeline.dispose();this.grid?.dispose();this.resize?.disconnect();clearTimeout(this.saveTimer);this.root.remove();}
}
