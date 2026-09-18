# Reliability changes (v0.13.3)

## Identity contract
- Local rowId is independent of grid position and display ID.
- Notebook source names are mapped by sourceId, never by UI/API list position.
- Extraction accepts exactly one response for the requested sourceId.
- Translation selects source controls by sourceId. Names are a per-request reply key only.
- Conflicting normalized names are isolated into single-source requests. Ambiguous replies are rejected.
- New translation requests persist row/source/name bindings. Existing incorrect names are updated only when a unique live sourceId binding is available and a new translation is prepared; no bulk migration guesses associations.

## Failure boundaries
- Runtime writes carry a runId; expired/released runs are rejected.
- Drive workers and Facebook extraction callbacks settle before the queue releases ownership.
- Facebook task IDs are unique per run. Event cursor advances after processing.
- Upload creation intent is persisted before requests. If no source ID is confirmed, subsequent retries are blocked for manual reconciliation. There is no automatic name-based adoption of unknown uploads.
- Sheet deletion eligibility requires unique per-row receipts; aggregate success cannot substitute for missing receipts.
- Completely empty unstarted drafts are excluded from normal Start; ID-only rows remain validation errors.

## Verification status
Automated tests cover reordered sources, duplicate normalized names, source-ID checkbox selection/restoration, stale run writes, deleted rows, contradictory receipts, worker draining, and blank drafts. Typecheck and build are required.

Edge read-only verification after reload confirmed the new build, successful workspace loading, and unique live source-ID bindings for all 10 previously imported rows (9 cached names were incorrect). Two same-name live sources had distinct source IDs. End-to-end Edge/Chrome verification remains required: home-to-notebook SPA entry, multi-source Drive import, duplicate-name translation, pause/resume, and mixed Drive/Facebook batches. No 1000-item live soak test has been completed. Existing sources/data were not directly rewritten during development.

## Remaining limits
- Remote create requests cannot be made atomic with local storage. Unknown outcomes stop for user reconciliation; there is not yet a dedicated reconciliation UI.
- A previously sent translation whose marked chat history is absent remains paused rather than blindly resubmitted.
- AI output completeness/semantic correctness cannot be guaranteed by JSON and identity validation.
- Pause waits for already-issued requests to finish; it is not an immediate remote cancellation.
- A per-row attempt counter and fully journaled remote-operation recovery are not introduced in this patch; run IDs plus draining bound current queue writes.
