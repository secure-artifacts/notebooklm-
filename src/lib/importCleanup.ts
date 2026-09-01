import type { TranscriptRecord } from "@/types/domain";

export function completedSourceIdsForCleanup(
  records: TranscriptRecord[],
  translationRequired: boolean
): string[] {
  return Array.from(new Set(records
    .filter((record) => record.sourceId && record.transcript && !record.error)
    .filter((record) => !translationRequired || Boolean(record.translation))
    .map((record) => record.sourceId)));
}

export function partitionInterruptedSourceIds(
  activeSourceIds: string[],
  records: TranscriptRecord[]
): { preserved: string[]; orphaned: string[] } {
  const activeIds = Array.from(new Set(activeSourceIds.filter(Boolean)));
  const recordedIds = new Set(records.map((record) => record.sourceId).filter(Boolean));
  return {
    preserved: activeIds.filter((sourceId) => recordedIds.has(sourceId)),
    orphaned: activeIds.filter((sourceId) => !recordedIds.has(sourceId))
  };
}
