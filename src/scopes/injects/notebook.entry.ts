import { installNotebookPageBridge } from "./notebook/pageBridge";

if (!window.__nlmVideoTranslationHelperPageBridgeHooked) {
  window.__nlmVideoTranslationHelperPageBridgeHooked = true;
  installNotebookPageBridge();
}
