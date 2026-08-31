export type NotebookBridgeAction =
  | "transcribe-single"
  | "upload-media-source"
  | "prepare-remote-media-source"
  | "get-source-summary"
  | "extract-existing-sources"
  | "delete-sources";

export const notebookBridgeActions = new Set<NotebookBridgeAction>([
  "transcribe-single",
  "upload-media-source",
  "prepare-remote-media-source",
  "get-source-summary",
  "extract-existing-sources",
  "delete-sources"
]);

export function isBridgeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/u.test(value);
}

export function isSafeNotebookPayload(action: NotebookBridgeAction, payload: unknown): payload is Record<string, any> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  if (action === "get-source-summary") return Object.keys(value).length === 0;
  if (action === "delete-sources") {
    if (!Array.isArray(value.sourceIds) || value.sourceIds.length > 50 || !validSourceIds(value.sourceIds)) return false;
    return value.sourceIds.length > 0 || value.deleteAll === true;
  }
  if (action === "extract-existing-sources") {
    const sourceIds = value.sourceIds;
    const skipSourceIds = value.skipSourceIds;
    return (sourceIds === undefined || (Array.isArray(sourceIds) && sourceIds.length <= 50 && validSourceIds(sourceIds))) &&
      (skipSourceIds === undefined || (Array.isArray(skipSourceIds) && skipSourceIds.length <= 50 && validSourceIds(skipSourceIds)));
  }
  if (action === "prepare-remote-media-source") {
    return typeof value.fileName === "string" && value.fileName.length > 0 && value.fileName.length <= 255 &&
      typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 200 * 1024 * 1024 &&
      typeof value.type === "string" && /^(audio|video)\/[A-Za-z0-9.+-]+$/u.test(value.type);
  }
  if (action === "transcribe-single" || action === "upload-media-source") {
    const file = value.file as File | undefined;
    return Boolean(file && typeof file.name === "string" && file.name.length <= 255 &&
      typeof file.size === "number" && file.size > 0 && file.size <= 200 * 1024 * 1024 &&
      /^(audio|video)\//u.test(file.type || ""));
  }
  return false;
}

function validSourceIds(values: unknown[]): boolean {
  return values.every(isBridgeIdentifier);
}
