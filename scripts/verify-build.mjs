import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const distDirectory = resolve("dist");
const loaderHtmlPath = resolve(distDirectory, "src/scopes/drive-loader/index.html");
const loaderHtml = await readFile(loaderHtmlPath, "utf8");
const moduleSource = loaderHtml.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i)?.[1];

if (!moduleSource || moduleSource.endsWith(".ts")) {
  throw new Error("Drive 下载组件未被 Vite 正确构建：index.html 仍指向源码或缺少模块脚本。");
}

const loaderScriptPath = resolve(distDirectory, moduleSource.replace(/^\//, ""));
await access(loaderScriptPath);
const loaderScript = await readFile(loaderScriptPath, "utf8");

if (!loaderScript.includes("drive-loader-ready")) {
  throw new Error("Drive 下载组件缺少就绪握手，已阻止生成不可用的扩展包。");
}

console.log(`Drive loader verified: ${moduleSource}`);
