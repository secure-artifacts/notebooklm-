import type { SourceControl, SourceSelection, TranscriptRecord } from "@/types/domain";

export const CHAT_INPUT_LABELS = ["查询框", "查詢方塊", "Query box"] as const;

export function getSourceControls(doc: Document): SourceControl[] {
  return Array.from(doc.querySelectorAll(".single-source-container"))
    .map((container) => {
      const button = container.querySelector<HTMLButtonElement>("button.source-stretched-button[aria-label]");
      const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      return {
        container,
        button,
        checkbox,
        name: button ? String(button.getAttribute("aria-label") || "").trim() : ""
      };
    })
    .filter((item): item is SourceControl => Boolean(item.name && item.checkbox));
}

export function captureSourceSelection(doc: Document): SourceSelection[] {
  return getSourceControls(doc).map((control) => ({
    name: control.name,
    checked: control.checkbox.checked
  }));
}

export function restoreSourceSelection(snapshot: SourceSelection[], doc: Document): void {
  if (!Array.isArray(snapshot)) return;
  const desiredByName = new Map(snapshot.map((item) => [item.name, Boolean(item.checked)]));
  getSourceControls(doc).forEach((control) => {
    if (!desiredByName.has(control.name)) return;
    const desired = desiredByName.get(control.name);
    if (control.checkbox.checked !== desired) control.checkbox.click();
  });
}

export function selectSourcesForRecords(
  records: TranscriptRecord[],
  namesMatch: (left: unknown, right: unknown) => boolean,
  doc: Document
) {
  const controls = getSourceControls(doc);
  const available = controls.slice();
  const selected: TranscriptRecord[] = [];
  const missing: TranscriptRecord[] = [];
  records.forEach((record) => {
    const matchIndex = available.findIndex((control) =>
      namesMatch(control.name, record.sourceOriginalName || record.sourceName));
    if (matchIndex < 0) {
      missing.push(record);
      return;
    }
    const [control] = available.splice(matchIndex, 1);
    selected.push(record);
    record._aiSourceControlName = control.name;
  });

  const targetNames = new Set(selected.map((record) => record._aiSourceControlName));
  controls.forEach((control) => {
    const shouldSelect = targetNames.has(control.name);
    if (control.checkbox.checked !== shouldSelect) control.checkbox.click();
  });
  return { selected, missing };
}

export async function selectSourcesForRecordsWhenReady(
  records: TranscriptRecord[],
  namesMatch: (left: unknown, right: unknown) => boolean,
  doc: Document,
  options: {
    attempts?: number;
    delayMs?: number;
    wait?: (delayMs: number) => Promise<void>;
  } = {}
) {
  const attempts = Math.max(1, Math.min(12, Math.floor(options.attempts || 8)));
  const delayMs = Math.max(100, Math.min(3000, Math.floor(options.delayMs || 750)));
  const wait = options.wait || ((duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration)));
  let result = selectSourcesForRecords(records, namesMatch, doc);
  for (let attempt = 1; result.missing.length && attempt < attempts; attempt += 1) {
    await wait(delayMs);
    result = selectSourcesForRecords(records, namesMatch, doc);
  }
  return result;
}

export function sourcesAreSelected(records: TranscriptRecord[], doc: Document): boolean {
  const selectedNames = new Set(records.map((record) => record._aiSourceControlName));
  return selectedNames.size === records.length && getSourceControls(doc).every((control) =>
    control.checkbox.checked === selectedNames.has(control.name));
}

export function findChatInput(doc: Document, panelRoot: Element | null): HTMLTextAreaElement | null {
  const chatPanel = doc.querySelector(".chat-panel");
  const scopedCandidates = chatPanel ? Array.from(chatPanel.querySelectorAll<HTMLTextAreaElement>("textarea")) : [];
  const labelledCandidates = CHAT_INPUT_LABELS.flatMap((label) =>
    Array.from(doc.querySelectorAll<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)));
  const structuralCandidates = Array.from(doc.querySelectorAll<HTMLTextAreaElement>("textarea"))
    .filter((textarea) => {
      if (panelRoot && panelRoot.contains(textarea)) return false;
      const form = textarea.closest("form");
      return Boolean(form && form.querySelector('button[type="submit"]'));
    });
  return [...scopedCandidates, ...labelledCandidates, ...structuralCandidates]
    .find((element) => isUsableControl(element, doc)) || null;
}

export function findChatPanel(input: HTMLTextAreaElement | null, doc: Document): Element | null {
  return doc.querySelector(".chat-panel") || input?.closest(".chat-panel") || null;
}

export function findChatSubmit(
  input: HTMLTextAreaElement,
  chatPanel: Element | null,
  doc: Document,
  panelRoot: Element | null
): HTMLButtonElement | null {
  const scopes = [input.closest("form"), chatPanel].filter((scope): scope is Element => Boolean(scope));
  for (const scope of scopes) {
    const submit = Array.from(scope.querySelectorAll<HTMLButtonElement>('button[type="submit"]'))
      .find((element) => isUsableControl(element, doc));
    if (submit) return submit;
  }
  return Array.from(doc.querySelectorAll<HTMLButtonElement>('button[type="submit"]'))
    .filter((button) => !(panelRoot && panelRoot.contains(button)))
    .find((element) => isUsableControl(element, doc)) || null;
}

export function isUsableControl(element: HTMLElement | null, doc: Document): boolean {
  if (!element || ("disabled" in element && Boolean(element.disabled)) || element.hidden) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const view = doc.defaultView || window;
  const style = view.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

export function getAiResponseTexts(responseRoot: ParentNode): string[] {
  return Array.from(responseRoot.querySelectorAll(".to-user-message-inner-content"))
    .map((message) => {
      const content = message.querySelector(".message-text-content") || message;
      const clone = content.cloneNode(true) as Element;
      clone.querySelectorAll(".citation-marker").forEach((marker) => marker.remove());
      return String(clone.textContent || "").trim();
    })
    .filter(Boolean);
}
