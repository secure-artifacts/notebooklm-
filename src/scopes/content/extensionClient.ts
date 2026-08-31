import {
  panelSettingsStorageKey,
  sheetSettingsStorageKey
} from "@/const";
import { schema, type SchemaType } from "@/schema";
import type {
  ColabApiRequest,
  ExtensionResources,
  InjectSettings,
  PanelSettings,
  SheetUpsertRequest
} from "@/types/messages";
import type { FacebookBulkJob, FacebookJobProgress } from "@/types/facebookJob";
import { useStorageLocal } from "@webextkits/storage-local";

const storage = useStorageLocal<SchemaType>(schema);
const runtimeChannel = "nlm-transcript-background";

type RuntimeResponse = { ok: true; result: unknown } | { ok: false; error: string };

type BackgroundAction = "upsertSheet" | "callColab" | "getColabSessionEvent" | "findReusableColabRuntime" |
  "loadFacebookJob" | "saveFacebookJob" | "updateFacebookJobProgress" | "updateFacebookJobActiveSources" | "clearFacebookJob";

function sendBackground(action: BackgroundAction, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`扩展后台请求超时：${action}`)), 30_000);
    chrome.runtime.sendMessage({ channel: runtimeChannel, action, payload }, (response: RuntimeResponse) => {
      clearTimeout(timer);
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) return reject(new Error(runtimeError.message));
      if (!response?.ok) return reject(new Error(response?.error || "扩展后台未返回结果。"));
      resolve(response.result);
    });
  });
}

export const extensionClient = {
  async getSettings(): Promise<InjectSettings> {
    const [panel, sheet] = await Promise.all([
      storage.getBucket(panelSettingsStorageKey, { autoFillDefault: true }),
      storage.getBucket(sheetSettingsStorageKey, { autoFillDefault: true })
    ]);
    return {
      panel,
      databaseUrl: sheet.databaseUrl,
      deploymentConfigured: Boolean(sheet.deploymentUrl),
      deploymentUrl: sheet.deploymentUrl
    };
  },

  savePanelSettings(settings: PanelSettings): Promise<void> {
    return storage.setBucket(panelSettingsStorageKey, settings);
  },

  async saveDatabaseUrl(databaseUrl: string): Promise<void> {
    await storage.updateBucket(sheetSettingsStorageKey, (settings) => ({
      ...settings,
      databaseUrl
    }), { autoFillDefault: true });
  },

  upsertSheet(request: SheetUpsertRequest): Promise<unknown> {
    return sendBackground("upsertSheet", request);
  },

  findReusableColabRuntime(): Promise<unknown> {
    return sendBackground("findReusableColabRuntime", {});
  },

  callColab(request: ColabApiRequest): Promise<unknown> {
    return sendBackground("callColab", request);
  },

  loadFacebookJob(notebookId: string): Promise<FacebookBulkJob | null> {
    return sendBackground("loadFacebookJob", { notebookId }) as Promise<FacebookBulkJob | null>;
  },

  saveFacebookJob(job: FacebookBulkJob): Promise<unknown> {
    return sendBackground("saveFacebookJob", { job });
  },

  updateFacebookJobActiveSources(notebookId: string, activeBatchStart: number, activeSourceIds: string[]): Promise<unknown> {
    return sendBackground("updateFacebookJobActiveSources", { notebookId, activeBatchStart, activeSourceIds });
  },

  updateFacebookJobProgress(progress: FacebookJobProgress): Promise<unknown> {
    return sendBackground("updateFacebookJobProgress", { progress });
  },

  clearFacebookJob(notebookId: string): Promise<unknown> {
    return sendBackground("clearFacebookJob", { notebookId });
  },

  getExtensionResources(): ExtensionResources {
    return {
      driveLoaderUrl: chrome.runtime.getURL("src/scopes/drive-loader/index.html"),
      iconUrl: chrome.runtime.getURL("icon-128.png"),
      extensionOrigin: new URL(chrome.runtime.getURL("/")).origin
    };
  }
};
