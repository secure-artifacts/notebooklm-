import "@/scopes/injects/notebook/styles.css";
import { bootNotebookApp } from "@/scopes/injects/notebook/app";

if (!window.__nlmVideoTranslationHelperHooked) {
  window.__nlmVideoTranslationHelperHooked = true;
  bootNotebookApp();
}
