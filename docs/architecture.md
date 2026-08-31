# 扩展架构

项目使用 TypeScript、Vite/CRXJS 与 WebExtKits storage-local。`src/` 是唯一源码，`dist/` 是唯一可加载和发布的扩展产物，不再维护旧版 JavaScript 副本。

## 设计原则

浏览器的隔离世界、页面 MAIN world 和 Background 是三种不同权限环境，必须明确分层：

- 隔离 Content Script 始终负责可见 UI 与任务编排；页面请求层失效时，面板仍能显示错误。
- MAIN world 只调用 NotebookLM 页面请求，不保存扩展设置，也不能调用 Background 权限。
- Background 只持有 Apps Script 部署链接并执行跨域登记。
- 跨环境协议保持小而明确，纯解析逻辑放在 `src/lib/` 并由单元测试覆盖。

## 运行环境

### Content Script（隔离世界）

- 入口：`src/scopes/content/index.ts`
- 扩展设置与 Background 客户端：`src/scopes/content/extensionClient.ts`
- NotebookLM 页面桥客户端：`src/scopes/content/notebookClient.ts`
- 面板与流程编排：`src/scopes/injects/notebook/app.ts`
- 面板样式：`src/scopes/injects/notebook/styles.css`

Content Script 由 Manifest 静态加载，在具体笔记本路由创建悬浮面板。它使用 WebExtKits storage-local 读取面板和表格设置，直接取得扩展资源 URL，并通过原生内部消息把登记请求交给 Background。

### NotebookLM MAIN world

- 入口：`src/scopes/injects/notebook.entry.ts`
- 页面桥：`src/scopes/injects/notebook/pageBridge.ts`
- NotebookLM 请求适配：`src/scopes/injects/notebook/apiClient.ts`

MAIN world 与 NotebookLM 共享登录上下文，只处理来源创建、上传、状态轮询、转录读取和来源删除。Content Script 与页面桥使用限定 origin、channel、target、首次绑定的随机 token 和 requestId 的消息协议；桥接层还执行动作白名单、载荷类型、来源数量、媒体类型与 200 MB 大小上限校验。删除全部来源必须携带显式 `deleteAll` 标记；进度和最终结果分开返回。

### Background Service Worker

- 入口：`src/scopes/background/index.ts`
- 内部消息：`src/scopes/background/messages.ts`
- 表格请求：`src/scopes/background/sheetService.ts`
- Facebook 队列检查点：`src/scopes/background/facebookJobStore.ts`

Background 仅接受来自本扩展的内部消息。Apps Script 部署链接不会发送给 NotebookLM 页面；登记前会再次校验部署链接、表格链接和每批 200 条上限。

### Drive Loader 与 Popup

- Drive Loader：`src/scopes/drive-loader/index.html`、`index.ts`
- Popup：`src/scopes/popup/index.html`、`index.ts`

Drive Loader 在隔离扩展页面中匿名下载公开 Drive 音视频并验证文件类型。Popup 保存 Apps Script 部署链接并提供打开 NotebookLM 的入口。

## 可测试模块

| 模块 | 职责 |
| --- | --- |
| `src/lib/aiTranslation.ts` | 翻译提示词、JSON 提取、来源名匹配与结果合并 |
| `src/lib/notebookDom.ts` | 多语言 DOM 定位、来源选择和回复清理 |
| `src/lib/driveImport.ts` | Drive 链接、分批、并发、重试与格式化 |
| `src/lib/sheetRegistration.ts` | URL 校验、记录转换、批次汇总与失败明细 |
| `src/lib/notebookApi.ts` | batchexecute、来源状态和转录响应解析 |
| `src/lib/colabProvider.ts` | Colab 模板 URL、Facebook 任务输入、结构化事件与错误分类 |

## 数据流

1. Content Script 面板创建导入或提取任务。
2. Drive Loader 下载文件并回传，Content Script 控制批次和并发。
3. Content Script 通过页面桥调用 MAIN-world NotebookLM 请求适配器。
4. Content Script 处理结果、AI 翻译、复制和自动清理。
5. Facebook 长队列按 20 条执行，Background 通过 IndexedDB 保存任务、增量结果和轻量活动批次检查点；意外中断后只重做尚未提交的批次。
6. 登记时，Content Script 每批最多 200 条发送给 Background；Background 加入私有部署链接并请求 Apps Script。

## 修改与发布规则

- RPC 变化：修改 `apiClient.ts` / `notebookApi.ts` 并增加测试样本。
- 页面结构或语言变化：修改 `notebookDom.ts`，避免依赖单一语言文案。
- 批次或重试变化：修改 `driveImport.ts`，不要把算法散落到按钮事件。
- 表格协议变化：同时修改 `sheetRegistration.ts` 与 Background `sheetService.ts`。
- 跨环境变化：先更新明确的消息类型/协议，再修改两端实现。

本地验收运行 `npm run check`。Release 工作流执行相同的类型检查、测试和生产构建，只打包 `dist/`，ZIP 根目录必须直接包含 `manifest.json`。

Colab provider 使用“Colab 直接写入 NotebookLM 申请的一次性 Google 上传会话”，实测不依赖浏览器 Cookie。正式状态机、浏览器级单例后端、批量队列、断点检查和失败补偿均已接入 UI；验证结论与安全边界见 `docs/colab-integration.md`。
