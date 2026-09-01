import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGithubColabUrl,
  buildColabScratchpadUrl,
  classifyColabFailure,
  colabBridgePrefix,
  decodeColabControlValue,
  isFacebookTableRowPopulated,
  parseColabBridgeOutput,
  parseColabControlEvents,
  parseGradioSseData,
  supportsColabShutdown,
  parseFacebookTasks,
  parseFacebookTableRows,
  parseFacebookClipboardRows,
  shouldAppendFacebookEditorRow
} from "../src/lib/colabProvider";

test("parseFacebookTasks accepts named and unnamed public links", () => {
  const result = parseFacebookTasks([
    "post_1001 https://www.facebook.com/watch/?v=1001",
    "https://fb.watch/AbC_123/",
    "post_1001 https://www.facebook.com/watch/?v=1001"
  ].join("\n"));

  assert.deepEqual(result.tasks, [
    {
      taskId: "fb-1",
      postId: "post_1001",
      url: "https://www.facebook.com/watch/?v=1001"
    },
    {
      taskId: "fb-2",
      postId: "facebook_2",
      url: "https://fb.watch/AbC_123/"
    }
  ]);
  assert.deepEqual(result.errors, []);
});

test("Colab shutdown requires an explicitly advertised capability", () => {
  assert.equal(supportsColabShutdown({ capabilities: ["shutdown"] }), true);
  assert.equal(supportsColabShutdown({ capabilities: [] }), false);
  assert.equal(supportsColabShutdown({}), false);
});

test("parseFacebookTasks reports malformed lines and enforces the batch limit", () => {
  const result = parseFacebookTasks([
    "not a link",
    "one https://facebook.com/watch/?v=1",
    "two https://facebook.com/watch/?v=2"
  ].join("\n"), 1);

  assert.equal(result.tasks.length, 1);
  assert.match(result.errors[0], /第 1 行/u);
  assert.match(result.errors[1], /最多 1 条/u);
});

test("Facebook table parser rejects missing, invalid and duplicate cells", () => {
  const result = parseFacebookTableRows([
    { postId: "post-1", url: "https://www.facebook.com/watch/?v=1" },
    { postId: "", url: "https://www.facebook.com/watch/?v=2" },
    { postId: "post-1", url: "https://www.facebook.com/watch/?v=3" },
    { postId: "post-4", url: "https://example.com/video" },
    { postId: "post-5", url: "https://www.facebook.com/watch/?v=1" }
  ]);
  assert.equal(result.tasks.length, 1);
  assert.deepEqual(result.issues.map((issue) => issue.index), [1, 2, 3, 4]);
  assert.match(result.errors.join("\n"), /缺少贴文 ID/u);
  assert.match(result.errors.join("\n"), /链接重复/u);
});

test("Facebook clipboard parser accepts spreadsheet columns and legacy lines", () => {
  assert.deepEqual(parseFacebookClipboardRows([
    "post-1\thttps://www.facebook.com/watch/?v=1\t忽略状态",
    "post-2 https://fb.watch/example/"
  ].join("\n")), [
    { postId: "post-1", url: "https://www.facebook.com/watch/?v=1", twoColumns: true },
    { postId: "post-2", url: "https://fb.watch/example/", twoColumns: true }
  ]);
});

test("Facebook editor keeps one automatic trailing row up to the task limit", () => {
  assert.equal(isFacebookTableRowPopulated({ postId: "", url: "" }), false);
  assert.equal(isFacebookTableRowPopulated({ postId: "post-1", url: "" }), true);
  assert.equal(shouldAppendFacebookEditorRow([], 1000), true);
  assert.equal(shouldAppendFacebookEditorRow([{ postId: "", url: "" }], 1000), false);
  assert.equal(shouldAppendFacebookEditorRow([{ postId: "post-1", url: "https://facebook.com/1" }], 1000), true);
  assert.equal(shouldAppendFacebookEditorRow([{ postId: "post-1", url: "https://facebook.com/1" }], 1), false);
});

test("parseColabBridgeOutput ignores partial and invalid events and deduplicates event ids", () => {
  const ready = `${colabBridgePrefix}{"event_id":"e1","type":"ready","protocol":1,"python":"3.13"}`;
  const complete = `${colabBridgePrefix}{"event_id":"e2","type":"complete","total":2,"succeeded":1,"failed":1}`;
  const events = parseColabBridgeOutput([
    "ordinary output",
    ready,
    ready,
    `${colabBridgePrefix}{"event_id":"partial"`,
    `${colabBridgePrefix}{"event_id":"bad","type":"complete","total":2,"succeeded":2,"failed":1}`,
    complete
  ].join("\n"));

  assert.deepEqual(events.map((event) => event.type), ["ready", "complete"]);
  assert.equal(events[0].event_id, "e1");
});

test("parseColabBridgeOutput reads auto-linked control JSON without relying on line boundaries", () => {
  const control = `${colabBridgePrefix}{"event_id":"control-1","type":"control","protocol":1,"session_id":"nlm-123456789012","base_url":"https://quiet-field.trycloudflare.com","token":"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"}`;
  const events = parseColabBridgeOutput(`rendered output before ${control}rendered output after`);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "control");
});

test("buildGithubColabUrl creates a non-saving GitHub playground URL", () => {
  assert.equal(
    buildGithubColabUrl({
      owner: "secure-artifacts",
      repository: "notebooklm-",
      path: "colab/notebooklm_bridge_probe.ipynb",
      language: "zh-CN"
    }),
    "https://colab.research.google.com/github/secure-artifacts/notebooklm-/blob/main/colab/notebooklm_bridge_probe.ipynb?playground=true&hl=zh-CN"
  );
});

test("buildGithubColabUrl carries an ephemeral session without a target tab", () => {
  const url = new URL(buildGithubColabUrl({
    owner: "secure-artifacts",
    repository: "notebooklm-",
    path: "colab/facebook_notebooklm_bridge.ipynb",
    sessionId: "nlm-123456789012"
  }));
  assert.equal(url.searchParams.get("playground"), "true");
  assert.equal(url.searchParams.get("nlm_session"), "nlm-123456789012");
  assert.equal(url.searchParams.has("nlm_target"), false);
});

test("buildColabScratchpadUrl uses the official non-saving notebook", () => {
  assert.equal(
    buildColabScratchpadUrl("nlm-123456789012", "zh-CN"),
    "https://colab.research.google.com/notebooks/empty.ipynb?nlm_session=nlm-123456789012&hl=zh-CN"
  );
  assert.throws(() => buildColabScratchpadUrl("short"), /会话编号/u);
});

test("control events require a trusted gradio.live origin and strong token", () => {
  const valid = `${colabBridgePrefix}${JSON.stringify({
    event_id: "control-1",
    type: "control",
    protocol: 1,
    session_id: "nlm-123456789012",
    base_url: "https://quiet-tree-123.gradio.live/path",
    token: "x".repeat(48)
  })}`;
  const invalid = `${colabBridgePrefix}${JSON.stringify({
    event_id: "control-2",
    type: "control",
    protocol: 1,
    session_id: "nlm-123456789012",
    base_url: "https://example.com",
    token: "x".repeat(48)
  })}`;
  const events = parseColabBridgeOutput(`${valid}\n${invalid}`);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "control");
  if (events[0].type === "control") assert.equal(events[0].base_url, "https://quiet-tree-123.gradio.live");
});

test("control events accept the Cloudflare fallback but reject unrelated tunnels", () => {
  const event = `${colabBridgePrefix}${JSON.stringify({
    event_id: "control-cf",
    type: "control",
    protocol: 1,
    session_id: "nlm-123456789012",
    base_url: "https://quiet-tree.trycloudflare.com",
    token: "y".repeat(48)
  })}`;
  assert.equal(parseColabBridgeOutput(event).length, 1);
});

test("control events accept the LocalTunnel fallback", () => {
  const event = `${colabBridgePrefix}{"event_id":"local-1","type":"control","protocol":1,"session_id":"nlm-123456789012","base_url":"https://quiet-field.loca.lt","token":"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"}`;
  const events = parseColabBridgeOutput(event);

  assert.equal(events.length, 1);
  if (events[0].type === "control") assert.equal(events[0].base_url, "https://quiet-field.loca.lt");
});

test("Gradio SSE and nested JSON outputs decode into task events", () => {
  const payload = JSON.stringify([{ event_id: "task-1", sequence: 1, type: "task", task_id: "fb-1", status: "downloaded", size: 100 }]);
  const sse = `event: complete\ndata: ${JSON.stringify([payload])}\n\n`;
  const values = parseGradioSseData(sse);
  assert.equal(values.length, 1);
  assert.deepEqual(decodeColabControlValue(values[0]), JSON.parse(payload));
  assert.equal(parseColabControlEvents(values[0])[0].type, "task");
});

test("classifyColabFailure maps actionable browser and runtime errors", () => {
  assert.equal(classifyColabFailure("浏览器不允许使用第三方 Cookie"), "third_party_cookies");
  assert.equal(classifyColabFailure("Runtime usage limit / quota reached"), "runtime_quota");
  assert.equal(classifyColabFailure("Please sign in first"), "login_required");
  assert.equal(classifyColabFailure("unknown failure"), "unknown");
});
