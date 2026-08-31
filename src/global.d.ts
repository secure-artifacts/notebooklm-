declare global {
  interface Window {
    __nlmVideoTranslationHelperHooked?: boolean;
    __nlmVideoTranslationHelperPageBridgeHooked?: boolean;
    WIZ_global_data?: Record<string, unknown>;
  }

  interface Error {
    code?: string;
    debug?: unknown;
    details?: unknown;
    httpStatus?: number;
    responsePreview?: string;
  }
}

export {};
declare module "*?raw" {
  const content: string;
  export default content;
}
