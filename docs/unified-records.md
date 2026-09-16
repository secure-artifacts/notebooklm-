# Unified record workspace

## Contract

One IndexedDB workspace per NotebookLM notebook. Each row has an immutable rowId;
displayId and URL are editable only until processing starts (including failed
or paused processing). An empty ID is assigned once by the download adapter.
Original source names and
NotebookLM source IDs are transport identities, never editable display IDs.
The grid, clipboard and Sheets exports all read workspace.rows. Queue batches
hold row IDs only. There is no second transcript/result collection.

Background transactions apply commands, check a workspace revision, and commit
atomically. Only one browser tab may run a notebook queue at a time. Page reload
releases that tab's previous lease and resumes from persisted row phases. A
conflicting tab must reload the workspace before writing.

The content app owns orchestration; Drive and Colab remain download adapters.
Each source is checkpointed before waiting for transcription. Successful text
is checkpointed before translation. Translation is saved before registration or
source removal. Pause completes the current request, saves it and starts no new
request. With AI enabled, only translated rows are eligible for auto-removal.

## Editing / export

ID and URL cells support spreadsheet selection and TSV paste. Text columns are
read-only, with a full-text dialog and range copy. Changing a completed row's URL
requires clearing that row first. Completion writes never replace a user ID.
Registration takes an immutable snapshot and records its receipt on that row.
Deleting rows deletes their local text; remote Sheets data is not deleted.

## Button and queue contract

Each queued row stores its own translation, automatic registration, registration
target and automatic removal requirements. Changing panel toggles never changes
the completion criteria of earlier rows. Start/continue skips completed and
failed rows; failures require explicit selected retry. Legacy completed records
without requirements are not automatically upgraded when AI is enabled.

Selected retry preserves completed text and only performs missing steps. If a
translation needs a removed source, the original URL is re-imported into the same
row, without discarding existing text. A row without a recoverable URL reports
an actionable failure. Selected retry can add the current translation or automatic
registration requirements but cannot silently remove previously required steps.

Delete-success uses each row's requirements, including required registration.
Manual registration records its target as a required step until acknowledged.
Registration receipts hash the canonical spreadsheet ID, gid and exported text.
The execution lock is synchronous, before the first storage await. Pause saves
the current operation, then starts no further registration/removal requests.

## Modules

- lib/recordWorkspace: row schema, command reducer, validation, migration, TSV
- background/recordWorkspaceStore: IndexedDB transactions and queue lease
- content/workspaceClient: versioned serialized commands
- content/workspacePipeline: mixed queue, checkpoints, cleanup, registration
- content/translationService and driveDownloadClient: provider adapters
- content/recordGrid: virtual rows, rectangular selection, resizing, text preview
- content/workspaceApp: panel controls and layout only

Migration reads the legacy Facebook checkpoint once, preserving unmatched result
records. The legacy store stays as a backup; an existing new workspace, including
an intentionally empty one, always wins. Tests cover migration, locked identity,
deletion, conflict handling, TSV and queue eligibility.
