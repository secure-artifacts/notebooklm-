import type { PanelSettings, SheetSettings } from "@/types/messages";
import type { JSONSchemaType } from "@webextkits/storage-local";

export const panelSettingsSchema: JSONSchemaType<PanelSettings> = {
  type: "object",
  properties: {
    aiTranslationEnabled: { type: "boolean", default: false },
    autoDeleteImported: { type: "boolean", default: true },
    autoRegisterImported: { type: "boolean", default: false },
    driveBatchSize: { type: "number", default: 10 },
    importMode: { type: "string", enum: ["drive", "facebook"], default: "drive" },
    facebookImportOpen: { type: "boolean", default: false },
    facebookAutoRegister: { type: "boolean", default: false },
    minimized: { type: "boolean", default: false },
    layout: {
      type: "object",
      default: {},
      required: [],
      additionalProperties: false,
      properties: {
        left: { type: "number", nullable: true, default: 0 },
        top: { type: "number", nullable: true, default: 0 },
        width: { type: "number", nullable: true, default: 0 },
        height: { type: "number", nullable: true, default: 0 }
      }
    }
  },
  required: ["aiTranslationEnabled", "autoDeleteImported", "autoRegisterImported", "driveBatchSize", "importMode", "facebookImportOpen", "facebookAutoRegister", "minimized", "layout"],
  default: {}
};

export const sheetSettingsSchema: JSONSchemaType<SheetSettings> = {
  type: "object",
  properties: {
    deploymentUrl: { type: "string", default: "" },
    databaseUrl: { type: "string", default: "" }
  },
  required: ["deploymentUrl", "databaseUrl"],
  default: {}
};
