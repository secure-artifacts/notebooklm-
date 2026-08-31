import { callNotebookApi, type NotebookAction } from "./apiClient";
import {
  isBridgeIdentifier,
  isSafeNotebookPayload,
  notebookBridgeActions,
  type NotebookBridgeAction
} from "@/lib/notebookBridge";

const channel = "nlm-transcript-page-api";
let boundToken = "";

export function installNotebookPageBridge(): void {
  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.channel !== channel || message.source !== "content" || message.target !== "page") return;
    if (message.type === "ping" && isBridgeIdentifier(message.token)) {
      if (boundToken && message.token !== boundToken) return;
      boundToken = message.token;
      window.postMessage({
        channel,
        token: message.token,
        source: "page",
        target: "content",
        type: "ready"
      }, window.location.origin);
      return;
    }
    if (message.type !== "request") return;
    const { token, requestId, action, payload } = message as {
      token: string;
      requestId: string;
      action: NotebookAction;
      payload: Record<string, any>;
    };
    if (!boundToken || token !== boundToken || !isBridgeIdentifier(requestId) || !notebookBridgeActions.has(action)) return;
    if (!isSafeNotebookPayload(action as NotebookBridgeAction, payload)) {
      window.postMessage({
        channel,
        token,
        requestId,
        source: "page",
        target: "content",
        type: "response",
        ok: false,
        error: "NotebookLM 页面请求参数无效。"
      }, window.location.origin);
      return;
    }

    const respond = (data: Record<string, unknown>) => window.postMessage({
      channel,
      token,
      requestId,
      source: "page",
      target: "content",
      ...data
    }, window.location.origin);

    try {
      const result = await callNotebookApi(action as NotebookAction, payload, (stage, detail) => {
        respond({ type: "progress", stage, detail });
      });
      respond({ type: "response", ok: true, result });
    } catch (error) {
      respond({
        type: "response",
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
