import { bootWorkspaceApp } from "./workspaceApp";

if (!window.__nlmVideoTranslationHelperHooked) {
  window.__nlmVideoTranslationHelperHooked = true;
  bootWorkspaceApp();
}
