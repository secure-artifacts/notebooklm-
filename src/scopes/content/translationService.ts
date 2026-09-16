import { buildTranslationPrompt, extractJsonArrayCandidates, sourceNamesMatch, mergeTranslationPayload } from "@/lib/aiTranslation";
import { captureSourceSelection, restoreSourceSelection, selectSourcesForRecordsWhenReady, sourcesAreSelected,
  findChatInput, findChatPanel, findChatSubmit, getAiResponseTexts, getUserMessageTexts, isNotebookAiGenerating } from "@/lib/notebookDom";
import type { RecordRow } from "@/lib/recordWorkspace";
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class TranslationPaused extends Error {}
export async function translateBatch(rows: RecordRow[], panel: HTMLElement, paused: () => boolean,
  checkpoint: (rowId: string, text: string) => Promise<void>): Promise<Map<string, string>> {
  const snapshot = captureSourceSelection(document), result = new Map<string, string>();
  let pending = structuredClone(rows);
  try {
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      if (paused()) throw new TranslationPaused("已暂停翻译");
      const selection = await selectSourcesForRecordsWhenReady(pending, sourceNamesMatch, document);
      if (selection.missing.length) throw new Error("左侧来源尚未同步或已移除，已暂停；请检查来源后重试。");
      if (!sourcesAreSelected(pending, document)) throw new Error("未能选中当前翻译来源");
      const payload = await submit(panel, paused);
      const merged = mergeTranslationPayload(payload, pending);
      for (const row of merged.translated as RecordRow[]) {
        await checkpoint(row.rowId, row.translation!);
        result.set(row.rowId, row.translation!);
      }
      pending = merged.missing as RecordRow[];
      if (paused()) break;
    }
    return result;
  } finally { restoreSourceSelection(snapshot, document); }
}
async function submit(panel: HTMLElement, paused: () => boolean): Promise<unknown[]> {
  const readyDeadline = Date.now() + 30_000;
  let input = findChatInput(document, panel);
  while ((!input || isNotebookAiGenerating(document, findChatPanel(input, document), panel)) && Date.now() < readyDeadline) {
    if (paused()) throw new TranslationPaused("已暂停翻译");
    await wait(250); input = findChatInput(document, panel);
  }
  if (!input || isNotebookAiGenerating(document, findChatPanel(input, document), panel)) throw new Error("NotebookLM 对话尚未就绪或仍在生成回答，队列已暂停。");
  const scope = findChatPanel(input, document) || document;
  const known = new Set(getAiResponseTexts(scope).flatMap((text) => extractJsonArrayCandidates(text).map((item) => item.raw)));
  const before = getAiResponseTexts(scope).length, userBefore = getUserMessageTexts(scope).length;
  const prompt = buildTranslationPrompt();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, prompt);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  let submitButton = findChatSubmit(input, findChatPanel(input, document), document, panel);
  const sendDeadline = Date.now() + 6000;
  while ((!submitButton || submitButton.disabled) && Date.now() < sendDeadline) {
    await wait(100); submitButton = findChatSubmit(input, findChatPanel(input, document), document, panel);
  }
  if (!submitButton || submitButton.disabled) throw new Error("翻译提示无法发送，队列已暂停。");
  if (paused()) throw new TranslationPaused("已暂停翻译");
  submitButton.click();
  const deadline = Date.now() + 15 * 60_000;
  let raw = "", stableAt = 0, observed = false;
  while (Date.now() < deadline) {
    const generating = isNotebookAiGenerating(document, findChatPanel(null, document), panel);
    const texts = getAiResponseTexts(scope);
    observed ||= generating || texts.length > before || getUserMessageTexts(scope).length > userBefore;
    const candidates = texts.flatMap(extractJsonArrayCandidates).filter((item) => !known.has(item.raw) && item.value.some((r: any) => typeof r?.source_name === "string" && typeof r.zh === "string" && r.zh && !r.zh.includes("完整简体中文翻译")));
    const newest = candidates.at(-1);
    if (newest) {
      if (raw !== newest.raw) { raw = newest.raw; stableAt = Date.now(); }
      else if (observed && !generating && Date.now() - stableAt > 1400 && findChatInput(document, panel)) return newest.value;
    }
    if (paused() && observed && !generating && !newest) throw new TranslationPaused("已暂停；本次回答未包含完整 JSON，保留来源供重试。");
    if (!observed && Date.now() > deadline - 15 * 60_000 + 15_000) throw new Error("NotebookLM 未接受提示，队列已暂停。");
    await wait(500);
  }
  throw new Error("等待 AI 完整翻译超时，已保存记录并保留来源，请等待网页完成后重试。");
}
