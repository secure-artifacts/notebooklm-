import packageJson from "../package.json";
import { notebookMatches } from "./const";
import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "NotebookLM 转录登记",
  version: packageJson.version,
  description: "批量导入公开 Drive 音视频，提取、翻译与清理 NotebookLM 来源，并登记到 Google 表格后端。",
  permissions: ["storage"],
  host_permissions: [
    ...notebookMatches,
    "https://colab.research.google.com/*",
    "https://drive.usercontent.google.com/*",
    "https://*.googleusercontent.com/outputframe.html*",
    "https://*.gradio.live/*",
    "https://*.trycloudflare.com/*",
    "https://*.loca.lt/*",
    "https://script.google.com/*",
    "https://script.googleusercontent.com/*"
  ],
  background: {
    service_worker: "src/scopes/background/index.ts",
    type: "module"
  },
  content_scripts: [
    {
      matches: notebookMatches,
      js: ["src/scopes/content/index.ts"],
      run_at: "document_start"
    },
    {
      matches: notebookMatches,
      js: ["src/scopes/injects/notebook.entry.ts"],
      run_at: "document_start",
      world: "MAIN"
    },
    {
      matches: ["https://colab.research.google.com/*"],
      js: ["src/scopes/content/colab.ts"],
      run_at: "document_end"
    },
    {
      matches: ["https://*.googleusercontent.com/outputframe.html*"],
      js: ["src/scopes/content/colabOutput.ts"],
      run_at: "document_end",
      all_frames: true
    }
  ],
  action: {
    default_title: "NotebookLM 转录登记",
    default_popup: "src/scopes/popup/index.html",
    default_icon: {
      "16": "icon-16.png",
      "32": "icon-32.png",
      "48": "icon-48.png",
      "128": "icon-128.png"
    }
  },
  icons: {
    "16": "icon-16.png",
    "32": "icon-32.png",
    "48": "icon-48.png",
    "128": "icon-128.png"
  },
  web_accessible_resources: [
    {
      resources: ["src/scopes/drive-loader/index.html", "icon-128.png"],
      matches: notebookMatches
    }
  ]
});
