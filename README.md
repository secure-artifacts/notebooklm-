# NotebookLM 转录登记

这是一个本地加载的 Chrome/Edge 扩展：把公开的 Google Drive 音视频批量加入当前 NotebookLM 笔记本，逐个读取来源转录稿，可选通过 NotebookLM AI 翻译为中文，并把结果登记到你的 Google Sheets 数据库服务。

> 当前版本：`v0.13.1` · 发布后下载并解压 Release 中的 ZIP，在浏览器扩展管理页使用「加载已解压的扩展程序」导入。

## 最新更新

### v0.13.1

- 支持 `fb.com`、`www.fb.com` 视频/贴文链接，下载前规范化为 `www.facebook.com`，保留路径和查询参数。
- 统一前端与 Colab 的 Facebook 域名校验，拒绝伪造域名、含用户凭据及非标准端口的链接。
- 更新后请重新加载扩展、刷新 NotebookLM，并重新启动 Colab 临时后端；仅 Facebook 首页地址不能指定下载视频。

### v0.13.0

- Drive / Facebook 合并为统一记录表，支持可选 ID、混合链接、拖动列宽、矩形选区和 TSV 复制粘贴；原文与译文直接显示在表格，双击查看全文。
- 记录统一存储于扩展 IndexedDB，按笔记本保存；暂停恢复、复制、登记与删除读取同一份数据。
- 每行独立保存翻译、登记和清理要求，修复混合导入、缺少 Colab 后端及失败重试的交互边界。
- 加强运行中编辑保护、自动删除回执校验和登记失败后的重试，保留未完成任务的正文及来源。

### v0.12.0

- 完善 Facebook 千条任务队列：二维表格批量粘贴、断点续传、清空/删除成功/重试选中及窄面板自适应布局。
- Colab 临时后端改为浏览器内复用单一会话，增加启动完整性校验、状态探测和安全结束后端功能。
- AI 翻译支持每批 `1–20` 个来源，强化发送与生成状态识别、翻译中断保护及安全来源清理，并明确仅根据转录原文翻译、无需研究。
- 自动登记按记录数和 UTF-8 请求体大小分批，遇到 HTTP 413 自动拆分重试，长错误日志改为摘要显示。

### v0.11.0

- 完整迁移到 TypeScript、Vite 与 WebExtKits 分层架构。
- 增加可恢复的 Facebook/Colab 批量导入、千条任务队列和每批自动登记。
- 固定 Colab 运行依赖，校验下载二进制，并限制单个媒体文件大小。

### v0.10.0

- 将 NotebookLM 页面 DOM 适配和 AI 翻译纯逻辑拆为独立模块，降低网站结构变化带来的维护风险。
- 新增来源名匹配、AI JSON 解析、多语言对话框识别、来源选择与引用标记清理等 10 项单元测试。
- GitHub Release 工作流会先运行单元测试，通过后才打包发布。
- AI 翻译提示词明确要求使用中国大陆通用的简体中文，并禁止输出繁体字。

### v0.9.9

- AI 对话输入框与发送按钮改为页面结构优先识别，不再依赖简体中文界面文案。
- 兼容简体中文、繁体中文和英文标签；其他语言在 NotebookLM 对话结构不变时同样可以识别。

### v0.9.8

- 新增兼容 `https://notebook.google.com/notebook/...` 笔记本地址，同时保留原有 `notebooklm.google.com` 地址支持。
- Drive 下载组件会根据当前 NotebookLM 域名安全回传下载进度与结果，确保新地址下的批量导入可用。
- 中文翻译已改由当前 NotebookLM 对话中的 AI 完成，替代原先的谷歌翻译方案；扩展不再调用谷歌翻译接口或要求翻译 API Key。

## 功能

- 同一个表格接收公开 Drive 音视频和 Facebook 视频链接，最多 1000 行；导入每批 1–20 条，默认 10 条，Drive 批内最多 3 路并发。
- ID 可留空：Drive 默认使用文件名，Facebook 优先使用下载器识别的编号，否则分配英文编号；开始处理后 ID 和链接锁定。
- 表格支持两列粘贴、矩形选区复制、拖动列宽、自动空行；原文与中文只读，双击查看完整内容，错误显示为单元格角标备注。
- 每行独立保存原文、翻译、登记及来源删除状态。改变面板开关不追溯改变旧任务；需要补做翻译等步骤时，勾选对应行并点击「重试选中」。
- 「开始 / 继续」处理待办与暂停任务；实际失败的记录通过「重试选中」恢复。未启动 Colab 时任务保持未开始，后端就绪后直接继续。
- 自动移除开启时，取得原文后才能清理；要求 AI 翻译时还必须取得译文，要求自动登记时还必须得到登记成功回执。未完成的来源保留。
- 「清空表格」「删除成功」删除对应本地记录和正文，不删除远端 Google 表格数据。「删除已添加的来源」经确认后删除笔记本全部来源，保留本地正文。
- AI 翻译每批 1–20 个来源，默认 5 个；只重试缺失译文，失败暂停，避免带着未完成翻译继续移除来源。
- 登记每次最多 200 条，并按 UTF-8 请求体大小继续拆分；HTTP 413 自动缩小批次，失败暂停并保留记录。
- 复制结果输出 ID、完整原文、中文三列，保留单元格内换行；有勾选时只复制对应记录。
- 支持 Chrome / Edge，以及 notebooklm.google.com 和 notebook.google.com 的笔记本页面。
- Drive 匿名下载无需 OAuth；Facebook 通过用户从扩展图标启动的唯一 Colab 临时后端下载。AI 翻译使用 NotebookLM 对话，不使用谷歌翻译 API。
- 面板支持拖动、缩放、最小化；统一表格使用虚拟行，操作日志可折叠。

登记时发送的记录字段如下：

| 字段 | 值 |
| --- | --- |
| `post_id` | 表格中的 ID；未填写时由下载结果自动确定 |
| `audio_content` | 完整转录文字 |
| `audio_content_zh` | 中文翻译；未开启翻译时为空字符串 |

## 配置表格服务

1. 在浏览器扩展栏点击「NotebookLM 转录登记」图标。
2. 输入 Apps Script Web App 的部署链接，格式应为 `https://script.google.com/macros/s/.../exec`，然后点击「保存设置」。
3. 在 NotebookLM 浮动面板顶部输入要写入的 Google 表格编辑链接；链接必须包含目标工作表的 `gid`，例如 `https://docs.google.com/spreadsheets/d/.../edit#gid=0`。
4. 表格链接会自动缓存，可以随时在浮动面板中更换。

点击面板的「登记表格」后，扩展将发送：

```text
POST <部署链接>?action=upsert
Content-Type: application/json
```

请求体包含 `database_url` 和 `records`。超过 `200` 条时会拆成多次请求，每次最多 `200` 条；面板记录逐行回执，失败信息显示在 ID 单元格备注中。表格必须已按后端服务说明授权给其执行账号写入。

## 使用流程

1. 使用 Release ZIP 时先解压；本地源码首次运行时执行 `npm ci && npm run build`。然后在 `chrome://extensions`（或 Edge 的 `edge://extensions`）开启开发者模式，选择「加载已解压的扩展程序」并加载解压目录或本项目的 `dist` 目录。不要直接加载源码根目录。
2. 打开 NotebookLM 笔记本并刷新页面。
3. 在统一表格粘贴链接，或粘贴 ID、链接两列；ID 可留空。Drive 文件必须公开并允许下载。
4. 若含 Facebook 链接，先在扩展图标中启动 Colab，等待后端就绪。
5. 设置 AI 翻译、自动移除及可选自动登记；自动登记需填写有效 Apps Script 部署链接和含 gid 的目标表格链接。
6. 点击「开始 / 继续」。暂停会等待当前操作保存后停止，已完成文本保留；重新打开同一笔记本可恢复本地记录。运行时请勿编辑任务。
7. 失败记录勾选后点击「重试选中」。未开启翻译的旧记录不会因后来开启开关而自动重做，可用选中重试补做。
8. 「提取现有来源」读取笔记本来源；「复制结果」导出三列；「登记表格」写入所选记录，无勾选时写入所有取得原文的记录。

## 项目结构与测试

- `src/manifest.ts`：Manifest V3 的唯一源码，由构建生成 `dist/manifest.json`。
- `src/scopes/content/`：隔离世界中的悬浮面板启动、设置访问、流程编排客户端和页面桥客户端。
- `src/scopes/injects/notebook/`：MAIN world 中最小化的 NotebookLM 页面请求适配与消息桥；面板不会依赖它才能显示。
- `src/scopes/background/`：私有部署配置和 Google Sheets 跨域登记。
- `src/scopes/drive-loader/`：公开 Drive 音视频匿名下载与类型验证。
- `src/scopes/popup/`：扩展图标弹窗与 Apps Script 部署链接配置。
- `src/lib/`：可独立测试的 AI 翻译、DOM、Drive、NotebookLM 响应和登记算法。
- `src/schema/`、`src/types/`：WebExtKits 存储 schema 与消息/领域类型。
- `tests/`：不访问网络的 TypeScript 单元测试。
- `dist/`：唯一可加载和发布的构建产物，不手工编辑。

本地检查：

```bash
npm ci
npm run check
```

项目已完整迁移到 TypeScript/Vite，并使用 WebExtKits storage-local 管理类型化设置，不再并行维护旧版 JavaScript 架构。UI、NotebookLM 页面请求和 Background 权限严格分层；`npm run check` 会依次执行严格类型检查、全部单元测试和 Vite 生产构建。完整边界说明见 [`docs/architecture.md`](docs/architecture.md)。

Release 工作流使用锁定依赖执行同一套检查，只打包 `dist/` 的内容；最终 ZIP 根目录直接包含 `manifest.json`。Apps Script 部署链接只保存在扩展存储并由 Background 使用，不会发送到 NotebookLM 页面环境。

## 隐私与限制

- 只有用户点击「开始导入」后，扩展才会下载用户填写的公开 Drive 音视频，并在当前 NotebookLM 笔记本创建来源和上传文件；文件按顺序处理，单个文件最高 512 MB。
- Drive 下载使用匿名请求，不读取 Cookie、密码或浏览器个人资料。私有文件、禁止下载的文件、非音视频响应和 Drive 权限页面会被拒绝。
- 链接、ID、原文、译文和处理状态按笔记本持久化到扩展本地 IndexedDB；「清空表格」会删除该表格的本地记录和正文。旧版 Facebook 检查点保留为迁移备份，不会覆盖已存在的新表格。卸载扩展可能丢失本地数据，请先复制或登记。
- 来源删除使用 NotebookLM 页面已登录上下文逐条执行，属于不可恢复操作；自动删除不会处理转录失败的来源，手动清空会先显示确认提示。
- 提取使用 NotebookLM 页面已登录上下文中的来源列表和来源详情请求；NotebookLM 的内部接口和数据结构可能变化。
- 启用 AI 翻译后，扩展会在当前 NotebookLM 对话框中发送固定翻译提示词；每次只选中当前待翻译的一批来源，读取其 JSON 回答并恢复用户原来的来源选择。翻译请求和回复均在当前 NotebookLM 会话内完成，扩展不调用谷歌翻译接口。NotebookLM 的回答可能受长度和服务限制影响，扩展会校验来源数量并记录失败项。
- 点击「登记表格」后，三列数据会发送到你在扩展图标中配置的 Apps Script 部署链接。

## 如何发布新版本

本项目使用 GitHub Actions 自动构建并发布。每次发布只需创建并推送一个版本 Tag；系统会自动打包扩展、生成构建溯源证明（Attestation），并创建 Release。

### 发布步骤

#### 1. 提交并推送代码

```bash
git status
git add .
git commit -m "你的改动说明"
git push origin main
```

#### 2. 创建并推送版本 Tag

版本号使用 `v主版本.次版本.修订版本` 格式，例如 `v0.12.0`。工作流会拒绝与扩展 manifest 版本不一致的 Tag。

```bash
git tag -a v0.12.0 -m "Release version 0.12.0"
git push origin v0.12.0
```

推送后，GitHub Actions 会自动：

1. 使用 `npm ci` 安装锁定版本依赖。
2. 执行 TypeScript 类型检查、全部单元测试和生产构建。
3. 校验构建生成的 `dist/manifest.json`。
4. 将 `dist/` 打包为根目录包含 `manifest.json` 的 ZIP。
5. 为最终 ZIP 生成 Attestation。
6. 创建 GitHub Release 并由 `github-actions[bot]` 上传 ZIP。

#### 3. 查看结果

- 构建进度：在仓库的 **Actions** 页面查看。
- 发布文件：在仓库的 **Releases** 页面下载。

### 如果构建失败

1. 在 **Actions** 页面查看失败日志并修复代码或工作流。
2. 删除失败的本地和远程 Tag。
3. 重新创建相同版本的 Tag 并推送：

```bash
git tag -d v0.12.0
git push origin :refs/tags/v0.12.0
git tag -a v0.12.0 -m "Release version 0.12.0"
git push origin v0.12.0
```
