import { extensionClient } from "./extensionClient";
import { isRetryableNetworkError } from "@/lib/driveImport";
const APP = "nlm-video-translation-helper";
export class DriveDownloadClient {
  private frame?: HTMLIFrameElement;
  private ready?: Promise<void>;
  private token = crypto.randomUUID();
  private resolveReady?: () => void;
  private pending = new Map<string, { resolve: (file: File) => void; reject: (error: Error) => void; timer: number; totalTimer: number; progress: (bytes: number) => void }>();
  private resources = extensionClient.getExtensionResources();
  constructor() { window.addEventListener("message", this.message); }
  private message = (event: MessageEvent) => {
    if (event.source !== this.frame?.contentWindow || event.origin !== this.resources.extensionOrigin) return;
    const data = event.data;
    if (data?.source !== APP || data.token !== this.token || data.target !== "content") return;
    if (data.type === "drive-loader-ready") { this.resolveReady?.(); return; }
    const p = this.pending.get(data.requestId); if (!p) return;
    if (data.type === "drive-download-progress") {
      clearTimeout(p.timer); p.timer = window.setTimeout(() => this.fail(data.requestId, "Drive 下载连续 90 秒无进度，已停止等待。"), 90_000);
      p.progress(Number(data.payload?.receivedBytes) || 0);
    } else if (data.type === "drive-download-response") {
      clearTimeout(p.timer); clearTimeout(p.totalTimer); this.pending.delete(data.requestId);
      if (data.payload?.ok && data.payload.file instanceof File) p.resolve(data.payload.file);
      else p.reject(new Error(data.payload?.error || "Drive 下载失败"));
    }
  };
  private fail(id: string, message: string) {
    const p = this.pending.get(id); if (!p) return;
    clearTimeout(p.timer); clearTimeout(p.totalTimer); this.pending.delete(id);
    this.frame?.contentWindow?.postMessage({ source: APP, target: "drive-loader", token: this.token, type: "drive-download-cancel", requestId: id }, this.resources.extensionOrigin);
    p.reject(new Error(message));
  }
  private ensure() {
    if (this.ready) return this.ready;
    const frame = document.createElement("iframe"); this.frame = frame;
    frame.style.display = "none"; frame.src = `${this.resources.driveLoaderUrl}#token=${this.token}`;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => { frame.remove(); this.ready = undefined; reject(new Error("Drive 下载组件未就绪，请重新加载扩展和页面。")); }, 15_000);
      this.resolveReady = () => { clearTimeout(timer); this.resolveReady = undefined; resolve(); };
    });
    document.documentElement.append(frame); return this.ready;
  }
  async download(url: string, progress: (bytes: number) => void): Promise<File> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensure(); const id = crypto.randomUUID();
        return await new Promise<File>((resolve, reject) => {
          const timer = window.setTimeout(() => this.fail(id, "Drive 下载超时：90 秒未收到数据。"), 90_000);
          const totalTimer = window.setTimeout(() => this.fail(id, "Drive 下载超过 30 分钟。"), 1_800_000);
          this.pending.set(id, { resolve, reject, timer, totalTimer, progress });
          this.frame!.contentWindow!.postMessage({ source: APP, target: "drive-loader", type: "drive-download-request", token: this.token, requestId: id, url }, this.resources.extensionOrigin);
        });
      } catch (error) {
        if (attempt >= 2 || !isRetryableNetworkError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
      }
    }
  }
  dispose() {
    for (const id of this.pending.keys()) this.fail(id, "页面已切换，下载已取消。");
    window.removeEventListener("message", this.message); this.frame?.remove();
  }
}
