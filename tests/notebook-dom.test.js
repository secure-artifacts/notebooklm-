"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const notebookDom = require("../src/modules/notebook-dom.js");

function createControl(overrides = {}) {
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

function createDocument(overrides = {}) {
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

  assert.equal(notebookDom.findChatInput(doc, panelRoot), input);
  assert.equal(notebookDom.findChatPanel(input, doc), chatPanel);
  assert.equal(notebookDom.findChatSubmit(input, chatPanel, doc, panelRoot), submit);
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
  const namesMatch = (left, right) =>
    left.replace(/\.mp3$/i, "").toLowerCase() === right.replace(/\.mp3$/i, "").toLowerCase();

  const result = notebookDom.selectSourcesForRecords(records, namesMatch, doc);
  assert.deepEqual(result.missing, []);
  assert.equal(firstCheckbox.checked, false);
  assert.equal(secondCheckbox.checked, true);
  assert.equal(notebookDom.sourcesAreSelected(records, doc), true);

  notebookDom.restoreSourceSelection(snapshot, doc);
  assert.equal(firstCheckbox.checked, true);
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

  assert.deepEqual(notebookDom.getAiResponseTexts(responseRoot), [
    '[{"source_name":"A","zh":"中文"}]'
  ]);
  assert.equal(markerRemoved, true);
});
