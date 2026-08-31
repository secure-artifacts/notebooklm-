export type TranscriptRecord = {
  sourceId: string;
  sourceName: string;
  sourceOriginalName?: string;
  transcript: string;
  translation?: string;
  translationError?: string;
  error?: string;
  sourceDeleted?: boolean;
  registered?: boolean;
  registrationError?: string;
  _aiSourceControlName?: string;
};

export type SourceControl = {
  container: Element;
  button: HTMLButtonElement | null;
  checkbox: HTMLInputElement;
  name: string;
};

export type SourceSelection = {
  name: string;
  checked: boolean;
};

export type LogEntry = {
  message: string;
  kind: string;
  time: string;
};
