import test from "node:test";
import assert from "node:assert/strict";
import {extractSourceRecords} from "../src/lib/notebookApi";
import {newRow,emptyWorkspace,applyWorkspaceCommand,shouldContinue,rowIssue} from "../src/lib/recordWorkspace";
import {confirmedSheetOutcomes} from "../src/lib/sheetRegistration";
import {mergeTranslationPayload} from "../src/lib/aiTranslation";
import {mapConcurrent} from "../src/lib/driveImport";
import {selectSourcesForRecords,sourcesAreSelected,captureSourceSelection,restoreSourceSelection} from "../src/lib/notebookDom";

test("source titles follow IDs despite reversed visible order",()=>{
 const a='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 const result=extractSourceRecords([[[a],'A.mp3',[null,2]],[[b],'B.mp3',[null,2]]],'cccccccc-cccc-cccc-cccc-cccccccccccc',{[b]:'visible B.mp3',[a]:'visible A.mp3'});
 assert.deepEqual(result.map(r=>[r.sourceId,r.sourceName]),[[a,'visible A.mp3'],[b,'visible B.mp3']]);
});
test("duplicate names are selected individually by source ID and restored individually",()=>{
 const checks=[true,false].map(checked=>({checked,click(){this.checked=!this.checked;}}));
 const containers=['a','b'].map((id,i)=>({querySelector:(s:string)=>s.startsWith('[id')?{id:`source-item-more-button-${id}`}:s.startsWith('button')?{getAttribute:()=> 'same.mp3'}:checks[i]}));
 const doc:any={querySelectorAll:()=>containers};const snapshot=captureSourceSelection(doc);
 const records:any=[{sourceId:'b',sourceName:'wrong.mp3'}];
 assert.equal(selectSourcesForRecords(records,()=>true,doc).missing.length,0);
 assert.deepEqual(checks.map(c=>c.checked),[false,true]);assert.equal(sourcesAreSelected(records,doc),true);
 assert.equal(records[0].sourceName,'same.mp3');restoreSourceSelection(snapshot,doc);assert.deepEqual(checks.map(c=>c.checked),[true,false]);
});
test("ambiguous normalized reply names are never assigned to the first row",()=>{
 const r=mergeTranslationPayload([{source_name:'same.mp3',zh:'text'}],[{sourceId:'a',sourceName:'same.mp3',transcript:'a'},{sourceId:'b',sourceName:'same.mp4',transcript:'b'}]);
 assert.equal(r.translated.length,0);assert.equal(r.missing.length,2);
});
test("blank draft skipped, ID-only draft flagged and unconfirmed creation blocked",()=>{
 assert.equal(shouldContinue(newRow()),false);assert.equal(rowIssue(newRow('id')),'请填写视频链接');
 const row=newRow('id','https://drive.google.com/file/d/1234567890abcd/view');row.creationUnconfirmed=true;
 assert.match(rowIssue(row),/未确认/);
});
test("deleted row and stale run results cannot overwrite surviving rows",()=>{
 let s=emptyWorkspace('test');s.rows=[newRow('a','','a'),newRow('b','','b')];
 s=applyWorkspaceCommand(s,{type:'delete',rowIds:['a']},1,0);
 s=applyWorkspaceCommand(s,{type:'claim',runId:'new'},1,1);
 assert.throws(()=>applyWorkspaceCommand(s,{type:'result',rowId:'b',runId:'old',patch:{transcript:'old'}},1,2),/失效/);
 assert.throws(()=>applyWorkspaceCommand(s,{type:'result',rowId:'a',runId:'new',patch:{transcript:'old'}},1,2),/删除/);
 s=applyWorkspaceCommand(s,{type:'release',runId:'new'},1,3);
 assert.throws(()=>applyWorkspaceCommand(s,{type:'result',rowId:'b',runId:'new',patch:{transcript:'old'}},1,4),/失效/);
 assert.equal(s.rows[0].rowId,'b');assert.equal(s.rows[0].transcript,'');
});
test("conflicting, missing and duplicated sheet receipts fail closed",()=>{
 const rows=[{post_id:'A',audio_content:'a',audio_content_zh:''},{post_id:'B',audio_content:'b',audio_content_zh:''}];
 assert.deepEqual(confirmedSheetOutcomes({ok:true,data:{summary:{success:2,failed:0}}},rows),[false,false]);
 assert.deepEqual(confirmedSheetOutcomes({ok:true,data:{results:[{index:0,post_id:'B',success:true},{index:1,post_id:'A',success:false}]}},rows),[false,false]);
 assert.deepEqual(confirmedSheetOutcomes({ok:true,data:{results:[{post_id:'B',success:true},{post_id:'A',success:true}]}},rows),[true,true]);
});
test("concurrent failure waits for in-flight work before returning",async()=>{
 let release!:()=>void,finished=false;const gate=new Promise<void>(r=>release=r);
 const work=mapConcurrent([1,2,3],2,async n=>{if(n===1)throw new Error('failed');await gate;finished=true;});
 const checked=assert.rejects(work,/failed/);await Promise.resolve();assert.equal(finished,false);release();await checked;assert.equal(finished,true);
});
