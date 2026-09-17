import { extractJsonArrayCandidates } from "./aiTranslation";

export type TranslationRequest = { id: string; prompt: string; createdAt: number };
export type ChatTurn = { role: "user" | "assistant"; text: string; complete?: boolean };

// A unique marker belongs to the user turn, not to the generated text. Identical
// translations in separate turns must remain separate responses.
export function locateTranslationReply(turns: ChatTurn[], request: TranslationRequest) {
  const marker = `[NLM:${request.id}]`;
  const matches = turns.map((t, i) => t.role === "user" && t.text.includes(marker) ? i : -1).filter(i => i >= 0);
  if (matches.length !== 1) return { accepted: false, ambiguous: matches.length > 1, text: "" };
  const tail = turns.slice(matches[0] + 1);
  if (tail.some(t => t.role === "user")) return { accepted: true, ambiguous: true, text: "" };
  const replies = tail.filter(t => t.role === "assistant");
  return { accepted: true, ambiguous: false, text: replies.map(t => t.text).join("\n"), complete: replies.length > 0 && replies.every(t => t.complete) };
}

export class TranslationReplyTracker {
  private text = "";
  private changedAt = 0;
  private idleAt: number | undefined;
  inspect(text: string, generating: boolean, inputReady: boolean, now: number): { state: "waiting" | "generating" | "checking" | "done" | "invalid" | "uncertain"; payload?: unknown[] } {
    if (text !== this.text) { this.text = text; this.changedAt = now; this.idleAt = undefined; }
    if (generating) { this.idleAt = undefined; return { state: "generating" }; }
    if (!text.trim()) return { state: "waiting" };
    this.idleAt ??= now;
    if (now - this.changedAt < 3000 || now - this.idleAt < 3000) return { state: "checking" };
    if (!inputReady) return { state: now - this.idleAt > 20000 ? "uncertain" : "checking" };
    const candidates = extractJsonArrayCandidates(text).filter(c => c.value.every((r: any) =>
      r && typeof r.source_name === "string" && typeof r.zh === "string"));
    return candidates.length === 1 ? { state: "done", payload: candidates[0].value } : { state: "invalid" };
  }
}
