import { buildTranslationPrompt, sourceNamesMatch, mergeTranslationPayload } from "@/lib/aiTranslation";
import { captureSourceSelection, restoreSourceSelection, selectSourcesForRecordsWhenReady, sourcesAreSelected,
  findChatInput, findChatPanel, findChatSubmit, getTranslationTurns, isNotebookAiGenerating } from "@/lib/notebookDom";
import { locateTranslationReply, TranslationReplyTracker, type TranslationRequest } from "@/lib/translationTurn";
import type { RecordRow } from "@/lib/recordWorkspace";
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export class TranslationPaused extends Error {}
type Hooks = { stage?: (text: string) => void; request?: (ids: string[], request?: TranslationRequest) => Promise<void> };
export async function translateBatch(rows: RecordRow[], panel: HTMLElement, paused: () => boolean,
  checkpoint: (rowId: string, text: string) => Promise<void>, hooks: Hooks = {}): Promise<Map<string, string>> {
  const snapshot = captureSourceSelection(document), result = new Map<string, string>();
  const groups = new Map<string, RecordRow[]>();
  for (const row of structuredClone(rows)) {
    const key = row.translationRequest?.id || "new";
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  try {
    for (const group of groups.values()) {
      let pending = group;
      for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
        if (paused()) throw new TranslationPaused("已暂停翻译");
        let request = pending[0].translationRequest;
        if (!request) {
          hooks.stage?.("等待对话就绪");
          const selection = await selectSourcesForRecordsWhenReady(pending, sourceNamesMatch, document);
          if (selection.missing.length || !sourcesAreSelected(pending, document)) throw new Error("未能确认当前翻译来源，来源已保留，请检查后重试。");
          request = await send(panel, paused, async r => {
            await hooks.request?.(pending.map(row => row.rowId), r);
          }, hooks);
        } else hooks.stage?.("正在恢复上次翻译回复");
        let payload: unknown[];
        try { payload = await receive(request, panel, paused, hooks); }
        catch (error) {
          // A conclusively finished invalid reply may be explicitly retried.
          if (error instanceof InvalidTranslationReply) await hooks.request?.(pending.map(row => row.rowId));
          throw error;
        }
        const merged = mergeTranslationPayload(payload, pending);
        for (const row of merged.translated as RecordRow[]) {
          await checkpoint(row.rowId, row.translation!); result.set(row.rowId, row.translation!);
        }
        await hooks.request?.(pending.map(row => row.rowId));
        pending = (merged.missing as RecordRow[]).map(row => ({ ...row, translationRequest: undefined }));
        if (paused()) break;
      }
      if (paused()) break;
    }
    hooks.stage?.(paused() ? "当前回复已保存，已暂停" : "翻译校验完成");
    return result;
  } finally { restoreSourceSelection(snapshot, document); }
}
class InvalidTranslationReply extends Error {}
async function send(panel: HTMLElement, paused: () => boolean, persist: (r: TranslationRequest) => Promise<void>, hooks: Hooks) {
  const deadline = Date.now() + 30000;
  let input = findChatInput(document, panel);
  while ((!input || isNotebookAiGenerating(document, findChatPanel(input, document), panel)) && Date.now() < deadline) {
    if (paused()) throw new TranslationPaused("已暂停翻译");
    await wait(250); input = findChatInput(document, panel);
  }
  if (!input || isNotebookAiGenerating(document, findChatPanel(input, document), panel)) throw new Error("NotebookLM 对话尚未就绪或仍在生成回答，队列已暂停。");
  const id = crypto.randomUUID();
  const request = { id, createdAt: Date.now(), prompt: buildTranslationPrompt() + "\n本次请求标记：[NLM:" + id + "]（仅用于区分请求，不要输出标记）。" };
  hooks.stage?.("正在发送翻译提示");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, request.prompt);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: request.prompt }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  let button = findChatSubmit(input, findChatPanel(input, document), document, panel);
  const sendDeadline = Date.now() + 6000;
  while ((!button || button.disabled) && Date.now() < sendDeadline) {
    await wait(100); button = findChatSubmit(input, findChatPanel(input, document), document, panel);
  }
  if (!button || button.disabled) throw new Error("翻译提示无法发送，队列已暂停。");
  if (paused()) throw new TranslationPaused("已暂停翻译");
  await persist(request); button.click(); return request;
}
async function receive(request: TranslationRequest, panel: HTMLElement, paused: () => boolean, hooks: Hooks): Promise<unknown[]> {
  const started = Date.now(), deadline = started + 15 * 60000, tracker = new TranslationReplyTracker();
  let lastStage = "";
  while (Date.now() < deadline) {
    // Re-query live DOM, since responsive changes can replace the chat panel.
    const scope = findChatPanel(null, document) || document;
    const reply = locateTranslationReply(getTranslationTurns(scope), request);
    if (reply.ambiguous) throw new Error("对话已插入其他请求，无法安全确认翻译归属；来源已保留。");
    const generating = isNotebookAiGenerating(document, findChatPanel(null, document), panel);
    const state = tracker.inspect(reply.text, generating, Boolean(reply.complete || findChatInput(document, panel)), Date.now());
    const stage = paused() ? "等待当前回答结束并保存后暂停" : state.state === "generating" ? "正在生成翻译" : state.state === "waiting" ? "等待 AI 回复" : "正在校验翻译结果";
    if (stage !== lastStage) { hooks.stage?.(stage); lastStage = stage; }
    if (reply.accepted && state.state === "done") return state.payload!;
    if (reply.accepted && state.state === "invalid") throw new InvalidTranslationReply("AI 回答已结束，但返回内容不是唯一、完整的翻译 JSON 数组；来源已保留，请重试选中。");
    if (state.state === "uncertain") throw new Error("已读取回复，但无法确认对话已就绪；来源已保留，请检查网页后重试。");
    if (!reply.accepted && Date.now() - started > 15000) throw new Error("未找到本次翻译提示，可能尚未加载历史对话；请检查页面。为避免重复发送，已保留请求记录。");
    if (paused() && !generating && !reply.text && Date.now() - started > 15000) throw new TranslationPaused("已暂停，尚未取得本次完整回复；继续时会先恢复此请求。");
    await wait(500);
  }
  throw new Error("等待本次翻译超时，来源与请求记录已保留；重试时将先检查已生成回复。");
}
