(function (root) {
  "use strict";

  const CHAT_INPUT_LABELS = Object.freeze([
    "查询框",
    "查詢方塊",
    "Query box"
  ]);

  function getSourceControls(doc) {
    return Array.from(doc.querySelectorAll(".single-source-container"))
      .map((container) => {
        const button = container.querySelector("button.source-stretched-button[aria-label]");
        const checkbox = container.querySelector('input[type="checkbox"]');
        return {
          container,
          button,
          checkbox,
          name: button ? String(button.getAttribute("aria-label") || "").trim() : ""
        };
      })
      .filter((item) => item.name && item.checkbox);
  }

  function captureSourceSelection(doc) {
    return getSourceControls(doc).map((control) => ({
      name: control.name,
      checked: control.checkbox.checked
    }));
  }

  function restoreSourceSelection(snapshot, doc) {
    if (!Array.isArray(snapshot)) return;
    const desiredByName = new Map(snapshot.map((item) => [item.name, Boolean(item.checked)]));
    getSourceControls(doc).forEach((control) => {
      if (!desiredByName.has(control.name)) return;
      const desired = desiredByName.get(control.name);
      if (control.checkbox.checked !== desired) control.checkbox.click();
    });
  }

  function selectSourcesForRecords(records, namesMatch, doc) {
    const controls = getSourceControls(doc);
    const available = controls.slice();
    const selected = [];
    const missing = [];
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

  function sourcesAreSelected(records, doc) {
    const selectedNames = new Set(records.map((record) => record._aiSourceControlName));
    return selectedNames.size === records.length &&
      getSourceControls(doc).every((control) =>
        control.checkbox.checked === selectedNames.has(control.name));
  }

  function findChatInput(doc, panelRoot) {
    const chatPanel = doc.querySelector(".chat-panel");
    const scopedCandidates = chatPanel
      ? Array.from(chatPanel.querySelectorAll("textarea"))
      : [];
    const labelledCandidates = CHAT_INPUT_LABELS.flatMap((label) =>
      Array.from(doc.querySelectorAll(`textarea[aria-label="${label}"]`)));
    const structuralCandidates = Array.from(doc.querySelectorAll("textarea"))
      .filter((textarea) => {
        if (panelRoot && panelRoot.contains(textarea)) return false;
        const form = textarea.closest("form");
        return Boolean(form && form.querySelector('button[type="submit"]'));
      });
    return [...scopedCandidates, ...labelledCandidates, ...structuralCandidates]
      .find((element) => isUsableControl(element, doc)) || null;
  }

  function findChatPanel(input, doc) {
    return doc.querySelector(".chat-panel") ||
      (input && input.closest(".chat-panel")) ||
      null;
  }

  function findChatSubmit(input, chatPanel, doc, panelRoot) {
    const scopes = [
      input && input.closest("form"),
      chatPanel
    ].filter(Boolean);
    for (const scope of scopes) {
      const submit = Array.from(scope.querySelectorAll('button[type="submit"]'))
        .find((element) => isUsableControl(element, doc));
      if (submit) return submit;
    }
    return Array.from(doc.querySelectorAll('button[type="submit"]'))
      .filter((button) => !(panelRoot && panelRoot.contains(button)))
      .find((element) => isUsableControl(element, doc)) || null;
  }

  function isUsableControl(element, doc) {
    if (!element || element.disabled || element.hidden) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    const view = doc.defaultView || root;
    const style = typeof view.getComputedStyle === "function"
      ? view.getComputedStyle(element)
      : { display: "", visibility: "" };
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function getAiResponseTexts(responseRoot) {
    return Array.from(responseRoot.querySelectorAll(".to-user-message-inner-content"))
      .map((message) => {
        const content = message.querySelector(".message-text-content") || message;
        const clone = content.cloneNode(true);
        clone.querySelectorAll(".citation-marker").forEach((marker) => marker.remove());
        return String(clone.textContent || "").trim();
      })
      .filter(Boolean);
  }

  const api = Object.freeze({
    CHAT_INPUT_LABELS,
    getSourceControls,
    captureSourceSelection,
    restoreSourceSelection,
    selectSourcesForRecords,
    sourcesAreSelected,
    findChatInput,
    findChatPanel,
    findChatSubmit,
    isUsableControl,
    getAiResponseTexts
  });

  root.NlmNotebookDom = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
