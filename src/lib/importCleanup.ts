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
