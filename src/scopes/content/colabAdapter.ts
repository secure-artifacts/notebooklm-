export type ColabRunTarget = {
  editor: HTMLTextAreaElement;
  runButton: HTMLButtonElement;
};

export function findColabRunTarget(root: ParentNode = document): ColabRunTarget | null {
  const runHost = root.querySelector<HTMLElement>("colab-run-button");
  const runButton = runHost?.shadowRoot?.querySelector<HTMLButtonElement>("button") || null;
  const editor = root.querySelector<HTMLTextAreaElement>(".monaco-editor textarea");
  return runButton && editor ? { editor, runButton } : null;
}

export async function replaceColabEditorText(editor: HTMLTextAreaElement, value: string): Promise<void> {
  editor.focus();
  editor.select();
  const chunkSize = 512;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const chunk = value.slice(offset, offset + chunkSize);
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, chunk);
    } catch {
      inserted = false;
    }
    if (!inserted) throw new Error("Colab 编辑器拒绝文本输入");
    await nextFrame();
    await nextFrame();
  }
  await delay(500);
}

export async function waitForColabEditorMarker(
  editor: HTMLTextAreaElement,
  marker: string,
  timeoutMs = 8_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const editorRoot = editor.closest<HTMLElement>(".monaco-editor");
  while (Date.now() < deadline) {
    const visibleText = editorRoot?.querySelector<HTMLElement>(".view-lines")?.textContent || "";
    if (editor.value.includes(marker) || visibleText.includes(marker)) return true;
    await delay(100);
  }
  return false;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
