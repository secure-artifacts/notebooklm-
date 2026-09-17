import test from "node:test";
import assert from "node:assert/strict";
import { locateTranslationReply, TranslationReplyTracker } from "../src/lib/translationTurn";
import { extractJsonArrayCandidates, mergeTranslationPayload } from "../src/lib/aiTranslation";
const request = { id: "new", prompt: "[NLM:new]", createdAt: 1 };
const text = '[{"source_name":"2286436975464525.mp4","zh":"请写下“阿门”吧。"}]';
test("identical historical and current replies remain separate turns", () => {
  const turns = [{ role: "user" as const, text: "old" }, { role: "assistant" as const, text },
    { role: "user" as const, text: request.prompt }, { role: "assistant" as const, text }];
  assert.equal(locateTranslationReply(turns, request).text, text);
  assert.equal(locateTranslationReply(structuredClone(turns), request).text, text);
  assert.equal(locateTranslationReply(turns.slice(0, 2), request).accepted, false);
});
test("interleaved requests and duplicate markers fail closed", () => {
  assert.equal(locateTranslationReply([{role:"user",text:request.prompt},{role:"user",text:"other"},{role:"assistant",text}],request).ambiguous,true);
  assert.equal(locateTranslationReply([{role:"user",text:request.prompt},{role:"user",text:request.prompt}],request).ambiguous,true);
});
test("valid partial output must wait until generation ends and settles", () => {
  const tracker = new TranslationReplyTracker();
  assert.equal(tracker.inspect(text,true,true,1).state,"generating");
  assert.equal(tracker.inspect(text,true,true,5000).state,"generating");
  assert.equal(tracker.inspect(text,false,true,6000).state,"checking");
  assert.equal(tracker.inspect(text,false,true,9001).state,"done");
});
test("finished invalid JSON reports invalid instead of waiting for total timeout", () => {
  const tracker = new TranslationReplyTracker();
  tracker.inspect('not JSON',false,true,1);
  assert.equal(tracker.inspect('not JSON',false,true,3002).state,"invalid");
});
test("conflicting input readiness has a bounded confirmation period", () => {
  const tracker = new TranslationReplyTracker();
  tracker.inspect(text,false,false,1);
  assert.equal(tracker.inspect(text,false,false,21002).state,"uncertain");
});
test("limited escaped-key repair preserves translation content", () => {
  const malformed = text.replace('source_name','source\\_name');
  assert.deepEqual(extractJsonArrayCandidates(malformed)[0].value[0], {source_name:"2286436975464525.mp4",zh:"请写下“阿门”吧。"});
  assert.equal(extractJsonArrayCandidates('[{"source_name":"x","zh":"bad\\q"}]').length,0);
});
test("duplicate source entries are not silently accepted", () => {
  const record = {sourceId:"s",sourceName:"x.mp4",transcript:"original"};
  const result = mergeTranslationPayload([{source_name:"x",zh:"one"},{source_name:"x.mp4",zh:"two"}], [record]);
  assert.equal(result.translated.length,0); assert.equal(result.missing.length,1);
});
