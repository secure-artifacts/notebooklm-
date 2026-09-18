import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkspaceAccess, loadWorkspaceWhenCurrent, WORKSPACE_ROUTE_MISMATCH } from "../src/lib/workspaceAccess";

const id = "06e086f5-8249-4ec2-945c-b710620cdbc8";
const home = "https://notebook.google.com/";
const live = `${home}notebook/${id}`;
test("SPA navigation uses live tab URL, not the sender's original document URL", () => {
  assert.doesNotThrow(() => validateWorkspaceAccess({url:home,frameId:0},live,id));
  assert.doesNotThrow(() => validateWorkspaceAccess({url:`${home}notebook/old`,frameId:0},`${live}/?x=1`,id));
  assert.doesNotThrow(() => validateWorkspaceAccess({url:"https://notebooklm.google.com/",frameId:0},`https://notebooklm.google.com/notebook/${id}`,id));
});
test("stale notebook requests, foreign origins and subframes fail closed", () => {
  for (const url of [home,`${home}notebook/other`]) assert.throws(() => validateWorkspaceAccess({url:live,frameId:0},url,id), /不匹配/);
  for (const sender of [{url:live,frameId:1},{url:live},{url:"https://evil.example/",frameId:0}]) assert.throws(() => validateWorkspaceAccess(sender,live,id), /来源无效/);
  assert.throws(() => validateWorkspaceAccess({url:home,frameId:0},undefined,id));
  assert.throws(() => validateWorkspaceAccess({url:home,frameId:0},"https://notebook.google.com.evil.example/",id));
});
test("initialization retries only transient route mismatch and is bounded", async () => {
  let calls=0;
  const waits:number[]=[];
  assert.equal(await loadWorkspaceWhenCurrent(async()=>{if(++calls<3)throw new Error(WORKSPACE_ROUTE_MISMATCH);},()=>true,async(ms)=>{waits.push(ms);}),true);
  assert.equal(calls,3);assert.deepEqual(waits,[350,700]);
  calls=0;
  await assert.rejects(loadWorkspaceWhenCurrent(async()=>{calls++;throw new Error(WORKSPACE_ROUTE_MISMATCH);},()=>true,async()=>{}));
  assert.equal(calls,4);
  calls=0;
  await assert.rejects(loadWorkspaceWhenCurrent(async()=>{calls++;throw new Error("database failed");},()=>true,async()=>{}),/database failed/);
  assert.equal(calls,1);
});
test("navigation cancels initialization before retry or after a pending load", async () => {
  let current=true,calls=0;
  assert.equal(await loadWorkspaceWhenCurrent(async()=>{calls++;throw new Error(WORKSPACE_ROUTE_MISMATCH);},()=>current,async()=>{current=false;}),false);
  assert.equal(calls,1);
  current=true;
  assert.equal(await loadWorkspaceWhenCurrent(async()=>{current=false;},()=>current),false);
});
