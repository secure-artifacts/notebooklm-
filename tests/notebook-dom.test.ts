import test from "node:test";
import assert from "node:assert/strict";
import * as notebookDom from "../src/lib/notebookDom";

function createControl(overrides: Record<string, any> = {}): any {
  return {
    disabled: false,
    hidden: false,
    checked: false,
    getAttribute: () => null,
    click() {
      this.checked = !this.checked;
    },
    ...overrides
  };
}

function createDocument(overrides: Record<string, any> = {}): any {
  return {
    defaultView: {
      getComputedStyle: () => ({ display: "block", visibility: "visible" })
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    ...overrides
  };
}

test("findChatInput and findChatSubmit prefer the chat structure without language text", () => {
  const submit = createControl();
  const form = {
    querySelector: (selector) => selector === 'button[type="submit"]' ? submit : null,
    querySelectorAll: (selector) => selector === 'button[type="submit"]' ? [submit] : []
  };
  const input = createControl({
    closest: (selector) => selector === "form" ? form : selector === ".chat-panel" ? chatPanel : null
  });
  const chatPanel = {
    querySelectorAll: (selector) => {
      if (selector === "textarea") return [input];
      if (selector === 'button[type="submit"]') return [submit];
      return [];
    }
  };
  const doc = createDocument({
    querySelector: (selector) => selector === ".chat-panel" ? chatPanel : null,
    querySelectorAll: (selector) => selector === "textarea" ? [input] : []
  });
  const panelRoot = { contains: () => false };

  assert.equal(notebookDom.findChatInput(doc, panelRoot as any), input);
  assert.equal(notebookDom.findChatPanel(input, doc), chatPanel as any);
  assert.equal(notebookDom.findChatSubmit(input, chatPanel as any, doc, panelRoot as any), submit);
});

test("findChatInput supports the Traditional Chinese label fallback", () => {
  const input = createControl({ closest: () => null });
  const doc = createDocument({
    querySelectorAll: (selector) =>
      selector === 'textarea[aria-label="查詢方塊"]' ? [input] : []
  });

  assert.equal(notebookDom.findChatInput(doc, null), input);
});

test("source selection can select a subset and restore the snapshot", () => {
  const firstCheckbox = createControl({ checked: true });
  const secondCheckbox = createControl({ checked: true });
  const containers = [
    {
      querySelector: (selector) =>
        selector.startsWith("button") ? { getAttribute: () => "first.mp3" } : firstCheckbox
    },
    {
      querySelector: (selector) =>
        selector.startsWith("button") ? { getAttribute: () => "second.mp3" } : secondCheckbox
    }
  ];
  const doc = createDocument({
    querySelectorAll: (selector) =>
      selector === ".single-source-container" ? containers : []
  });
  const snapshot = notebookDom.captureSourceSelection(doc);
  const records = [{ sourceName: "second", sourceOriginalName: "second.mp3" }];
  const namesMatch = (left: unknown, right: unknown) =>
    String(left).replace(/\.mp3$/i, "").toLowerCase() === String(right).replace(/\.mp3$/i, "").toLowerCase();

  const result = notebookDom.selectSourcesForRecords(records as any, namesMatch, doc);
  assert.deepEqual(result.missing, []);
  assert.equal(firstCheckbox.checked, false);
  assert.equal(secondCheckbox.checked, true);
  assert.equal(notebookDom.sourcesAreSelected(records as any, doc), true);

  notebookDom.restoreSourceSelection(snapshot, doc);
  assert.equal(firstCheckbox.checked, true);
  assert.equal(secondCheckbox.checked, true);
});

test("source selection waits for newly rendered source controls", async () => {
  const firstCheckbox = createControl({ checked: true });
  const secondCheckbox = createControl({ checked: false });
  const containers = [
    {
      querySelector: (selector) =>
        selector.startsWith("button") ? { getAttribute: () => "first.mp3" } : firstCheckbox
    },
    {
      querySelector: (selector) =>
        selector.startsWith("button") ? { getAttribute: () => "second.mp3" } : secondCheckbox
    }
  ];
  let rendered = 1;
  const doc = createDocument({
    querySelectorAll: (selector) =>
      selector === ".single-source-container" ? containers.slice(0, rendered) : []
  });
  const records = [{ sourceName: "second", sourceOriginalName: "second.mp3" }];
  const result = await notebookDom.selectSourcesForRecordsWhenReady(
    records as any,
    (left, right) => String(left) === String(right),
    doc,
    {
      attempts: 3,
      delayMs: 100,
      wait: async () => { rendered = 2; }
    }
  );

  assert.deepEqual(result.missing, []);
  assert.equal(firstCheckbox.checked, false);
  assert.equal(secondCheckbox.checked, true);
});

test("getAiResponseTexts removes citation markers from cloned replies", () => {
  let markerRemoved = false;
  const clone = {
    textContent: '[{"source_name":"A","zh":"中文"}]',
    querySelectorAll: (selector) =>
      selector === ".citation-marker" ? [{ remove: () => { markerRemoved = true; } }] : []
  };
  const message = {
    querySelector: (selector) =>
      selector === ".message-text-content" ? { cloneNode: () => clone } : null
  };
  const responseRoot = {
    querySelectorAll: (selector) =>
      selector === ".to-user-message-inner-content" ? [message] : []
  };

  assert.deepEqual(notebookDom.getAiResponseTexts(responseRoot as any), [
    '[{"source_name":"A","zh":"中文"}]'
  ]);
  assert.equal(markerRemoved, true);
});
