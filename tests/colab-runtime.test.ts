import test from "node:test";
import assert from "node:assert/strict";
import {
  COLAB_RUNTIME_STALE_MS,
  COLAB_START_TIMEOUT_MS,
  isColabRuntimeStale,
  isColabStartupExpired,
  isValidColabSessionId,
  runtimeStateLabel,
  type ColabRuntimeSnapshot
} from "../src/lib/colabRuntime";
import { buildColabBootstrapSource } from "../src/lib/colabBootstrap";

function snapshot(state: ColabRuntimeSnapshot["state"], startedAt = 1_000, lastSeenAt = 1_000): ColabRuntimeSnapshot {
  return {
    tabId: 42,
    sessionId: "nlm-123456789012",
    state,
    startedAt,
    lastSeenAt
  };
}

test("Colab runtime session ids reject short or unsafe values", () => {
  assert.equal(isValidColabSessionId("nlm-123456789012"), true);
  assert.equal(isValidColabSessionId("short"), false);
  assert.equal(isValidColabSessionId("nlm-123456789012?other=1"), false);
});

test("only a starting runtime expires at the startup deadline", () => {
  assert.equal(isColabStartupExpired(snapshot("starting"), 1_000 + COLAB_START_TIMEOUT_MS - 1), false);
  assert.equal(isColabStartupExpired(snapshot("starting"), 1_000 + COLAB_START_TIMEOUT_MS), true);
  assert.equal(isColabStartupExpired(snapshot("ready"), 1_000 + COLAB_START_TIMEOUT_MS), false);
});

test("ready runtime staleness is based on last successful observation", () => {
  assert.equal(isColabRuntimeStale(snapshot("ready"), 1_000 + COLAB_RUNTIME_STALE_MS - 1), false);
  assert.equal(isColabRuntimeStale(snapshot("ready"), 1_000 + COLAB_RUNTIME_STALE_MS), true);
  assert.equal(isColabRuntimeStale(snapshot("starting"), 1_000 + COLAB_RUNTIME_STALE_MS), false);
});

test("runtime labels cover every user-visible state", () => {
  assert.equal(runtimeStateLabel("stopped"), "未启动");
  assert.equal(runtimeStateLabel("starting"), "启动中");
  assert.equal(runtimeStateLabel("ready"), "已就绪");
  assert.equal(runtimeStateLabel("stale"), "连接已失效");
  assert.equal(runtimeStateLabel("failed"), "启动失败");
});

test("Colab bootstrap is split into bounded lines and ends with an integrity marker", () => {
  const encodedPayload = "A".repeat(2_300);
  const payloadSha256 = "0123456789abcdef".repeat(4);
  const bootstrap = buildColabBootstrapSource({
    sessionId: "nlm-123456789012",
    encodedPayload,
    payloadSha256,
    compressed: true
  });

  assert.equal(bootstrap.marker, "NLM_BOOTSTRAP_END_0123456789abcdef");
  assert.equal(bootstrap.code.endsWith(`# ${bootstrap.marker}`), true);
  assert.equal(Math.max(...bootstrap.code.split("\n").map((line) => line.length)) <= 482, true);
  assert.equal((bootstrap.code.match(/"A+"/gu) || []).map((value) => value.slice(1, -1)).join(""), encodedPayload);
  assert.match(bootstrap.code, /hashlib\.sha256/);
  assert.match(bootstrap.code, /gzip\.decompress/);
});
