import type { PanelSettings, SheetSettings } from "@/types/messages";
import { panelSettingsStorageKey, sheetSettingsStorageKey } from "@/const";
import { panelSettingsSchema, sheetSettingsSchema } from "./settings";

export type SchemaType = {
  [panelSettingsStorageKey]: PanelSettings;
  [sheetSettingsStorageKey]: SheetSettings;
};

export const schema = {
  [panelSettingsStorageKey]: panelSettingsSchema,
  [sheetSettingsStorageKey]: sheetSettingsSchema
};
