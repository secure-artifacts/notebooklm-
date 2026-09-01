export type PanelLayout = {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
};

export type PanelSettings = {
  aiTranslationEnabled: boolean;
  aiTranslationBatchSize: number;
  autoDeleteImported: boolean;
  autoRegisterImported: boolean;
  driveBatchSize: number;
  importMode: "drive" | "facebook";
  facebookImportOpen: boolean;
  facebookAutoRegister: boolean;
  minimized: boolean;
  layout: PanelLayout;
};

export type SheetSettings = {
  deploymentUrl: string;
  databaseUrl: string;
};

export type InjectSettings = {
  panel: PanelSettings;
  databaseUrl: string;
  deploymentConfigured: boolean;
  deploymentUrl: string;
};

export type ExtensionResources = {
  driveLoaderUrl: string;
  iconUrl: string;
  extensionOrigin: string;
};

export type ColabApiName = "health" | "start_batch" | "provide_upload" | "poll_events" | "cancel_batch" | "shutdown";

export type ColabApiRequest = {
  baseUrl: string;
  token: string;
  apiName: ColabApiName;
  data: unknown[];
};

export type SheetRecord = {
  post_id: string;
  audio_content: string;
  audio_content_zh: string;
};

export type SheetUpsertRequest = {
  databaseUrl: string;
  records: SheetRecord[];
};
