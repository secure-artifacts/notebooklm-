# Colab 集成准备与现场验证

更新时间：2026-08-31。本文只记录已经验证的行为、扩展边界和实现契约；尚未通过的能力不会标记为可用。

## 目标

用户先通过扩展图标启动浏览器级唯一的 Colab 临时后端；随后在 NotebookLM 页面粘贴 Facebook 帖文 ID 与公共链接。Notebook 页面只连接后端，不再自行打开 Colab。后端完成下载后，把命名后的音视频直接交给 NotebookLM 上传流程。

## 2026-08-30 Edge 现场结果

| 项目 | 结果 | 备注 |
| --- | --- | --- |
| Edge 已登录 Colab | 通过 | 当前账号可分配 CPU 运行时。 |
| GitHub 笔记本临时编辑 | 通过 | GitHub 托管笔记本显示“复制到云端硬盘”，修改和运行不会覆盖源文件，也没有主动写入 Drive。 |
| 自动激活代码单元格 | 通过 | 使用稳定元素 `colab-run-button`，不依赖界面语言。 |
| 自动写入代码 | 通过 | 编辑器为 `.monaco-editor textarea`；必须先聚焦、`Ctrl+A`，再写入，否则 Colab 会把新代码追加到旧代码后面。 |
| 自动运行与读取文本输出 | 通过 | 中文和英文界面均可读取 `NLM_BRIDGE:` 开头的结构化事件。 |
| 中文/英文界面兼容 | 通过 | `colab-run-button`、`colab-connect-button`、`.monaco-editor textarea` 在两种语言下保持一致。 |
| `FileLink`/输出框文件回传 | 未通过 | Edge 报告输出框 JavaScript 无法加载，原因是第三方 Cookie 被阻止或登录状态不可用于输出 iframe。 |
| NotebookLM 一次性上传会话（无 Cookie） | 通过 | 1 KiB MP3 探针以 `credentials: omit` 完成 `upload, finalize`，HTTP 200，并在 `finally` 中删除临时来源。 |
| 大文件端到端自动上传 | 通过 | 62.3 MB MP4 已完成 Facebook 下载、Colab → Google 直传、NotebookLM 转录和来源补偿删除。 |

现场运行时探针返回 Python 3.13.15、Linux。版本只用于记录，代码不得依赖这个具体版本。

## 公网 provider 与真实媒体测试

同日在重新连接的 Edge/Colab 会话中继续完成以下验证。所有测试都使用临时 CPU 运行时，没有 Google Drive 挂载、Facebook Cookie 或真实账号凭证。

### Gradio 6.26

- Colab 已预装 Gradio 6.26.0，不需要启动时重复安装。
- `share=True` 约 2.4～3.5 秒生成临时 `*.gradio.live` 地址。
- `/gradio_api/openapi.json`、`/gradio_api/call/v2/<api_name>` 和 SSE 结果读取正常。
- API 请求不需要 Google 或 Colab Cookie；随机任务令牌校验正常，错误令牌返回明确错误事件。
- 扩展 Origin 的 CORS 预检通过；中文和空格文件名在 `Content-Disposition` 中使用 UTF-8 编码正确返回。
- 文件端点支持 HTTP Range，`bytes=100-199` 返回 206。
- 最终 `/gradio_api/file=...` URL 本身不再校验任务令牌。因此必须使用不可猜测目录/文件标识、短生命周期和及时清理，不能把普通文件名直接暴露为永久 URL。
- 4 MiB 假文件实测约 0.35 MiB/s；10.55 MB 真实 MP4 实测约 32.1 秒、0.31 MiB/s。少量任务可用，数百个视频会被回传带宽严重限制。

Edge 对直接导航 OpenAPI JSON 显示 `ERR_BLOCKED_BY_CLIENT`，但普通 HTTP 请求和 CORS 预检均成功。这是 JSON 导航/内容拦截行为，不是 API 网络不可达。

### FastAPI + Cloudflare Quick Tunnel

- 启动 FastAPI、下载 `cloudflared` 并获得临时 `*.trycloudflare.com` 地址共约 7.5 秒。
- 健康检查、创建文件和文件 GET 都可要求 `Authorization: Bearer ...`；未认证 GET 返回 401。
- 扩展 Origin 的 CORS、Authorization/Range 预检、中文文件名和 206 Range 下载均通过。
- 1 MiB 文件实测约 0.11 MiB/s，当前线路比 Gradio 更慢。

该方案下载鉴权更完整、协议完全可控，但 Quick Tunnel 的吞吐和可用性不适合直接承载数百个视频。它仍可用作小型控制面，不应作为大媒体数据面。

2026-08-31 在目标 Edge 环境中确认本地 DNS 无法解析 `*.trycloudflare.com`，因此生产实现不再把它作为首选控制通道。

### Gradio + LocalTunnel 控制面

- Colab 使用 `npx localtunnel` 建立随机 `*.loca.lt` HTTPS 地址，Cloudflare Quick Tunnel 仅作为启动失败时的备用。
- 扩展只允许 `gradio.live`、`trycloudflare.com` 和 `loca.lt` 的随机子域，并为 LocalTunnel 请求携带免提示请求头。
- 控制消息使用随机会话令牌；上传 URL 仅在内存中短暂传递，不写日志或扩展存储。
- 目标 Windows/Edge 环境已确认 LocalTunnel 可解析且返回 HTTP 200。
- 控制事件同时通过受限 `postMessage` 从 Colab 输出 iframe 回传；结构化文本解析只作为兼容备用，避免依赖 Colab 对 URL 的自动链接和可视换行。

### 匿名 Facebook 下载

使用 Facebook 官方公开视频 `238358730483` 验证：

- `yt-dlp` 无 Cookie 元数据探测成功，识别到 204.57 秒、MP4、2 个格式。
- 选择低清晰度 MP4 后，Colab 约 2.84 秒下载 10,548,839 字节。
- `ffprobe` 确认文件包含 H.264 400×224 视频流和 AAC 音频流，时长约 204.57 秒。

这证明“公开 Facebook → Colab”不是当前速度瓶颈；瓶颈是“Colab → 插件浏览器”的公网隧道。

## 已落地的协议

### 浏览器级运行时管理

- 后台以 `chrome.storage.session` 保存唯一 Colab 辅助标签的 `tabId`、`sessionId`、状态和最近观察时间；关闭浏览器后自动清除，不写入永久存储。
- Popup 的重复启动请求由后台互斥，避免并发创建多个 scratchpad。
- 启动状态超过 90 秒仍未就绪时标记失效；用户再次启动时只刷新原辅助标签，不继续创建新标签。
- NotebookLM 在提交 Facebook 批次前调用带随机令牌的 `health` 接口；健康检查失败时不创建来源、不提交下载任务。
- Colab 页面 DOM 选择和编辑器分段写入集中在独立适配器中，页面结构变化时只需修改一个模块。

- 探针模板：`colab/notebooklm_bridge_probe.ipynb`
- 解析与校验：`src/lib/colabProvider.ts`
- 回归测试：`tests/colab-provider.test.ts`
- 输出前缀：`NLM_BRIDGE:`
- 协议版本：`1`

每个事件都必须有唯一 `event_id`，以消除 Colab DOM 重绘或重复采集造成的重复。当前事件类型为：

- `ready`：运行时和协议就绪。
- `task`：单个下载任务的排队、下载中、文件就绪或失败状态。
- `complete`：一批任务的总数、成功数和失败数。
- `fatal`：整批无法继续的错误。

插件按 JSON 对象边界解析 `NLM_BRIDGE:` 事件，不依赖可视行边界；普通日志、半截 JSON 和未知协议都会忽略。首选通道是输出 iframe 到 Colab 顶层内容脚本的受限 `postMessage`，文本扫描为备用。

## 推荐实现边界

### 浏览器扩展负责

1. 解析并验证 Facebook 公共链接，生成稳定的 `task_id` 和 `post_id`。
2. 扩展弹出页负责启动或聚焦不保存到 Google Drive 的唯一 Colab scratchpad；后台清理带 `nlm_session` 的重复辅助标签。
3. Colab 内容脚本通过不依赖语言的 DOM 元素激活编辑器、写入 Base64 单行启动脚本并运行。
4. Notebook 页面只查询已就绪的运行时；未启动时明确提示用户从扩展图标启动，不自动跳页。
5. 接收结构化控制事件，显示下载、直传、处理和失败原因。
6. 为已校验媒体申请 Google 一次性上传地址，交给 Colab 直传，再轮询、提取和按选项清理来源。

### Colab 模板负责

1. 只处理用户明确提供的公共 Facebook 链接。
2. 检查下载结果的 MIME、扩展名、大小和媒体流。
3. 保留用户提供的 `post_id` 作为安全文件名，禁止路径穿越。
4. 为每个任务发出结构化事件；单个失败不能终止整批。
5. 退出时清理 `/content` 中的临时文件。

## 大文件传输的现实选择

### A. 官方 Colab 下载 + 用户选择文件

最容易维护，也不需要公开临时后端。Colab 通过 `google.colab.files.download()` 下载到浏览器，用户一次选择这批文件，扩展随后批量上传。缺点是存在一次文件选择交互，无法完全无人值守。

### B. 官方 Colab CLI + 本地伴随程序

最适合真正全自动：本地伴随程序通过官方 Colab CLI 启动运行时、执行脚本并下载产物，然后用 Native Messaging 把文件交给扩展。缺点是首次需要安装和 Google 授权，发布包也要维护浏览器扩展与本地程序两部分。

### C. Colab 中启动 Gradio/隧道公网服务

不作为默认实现。Colab 官方 FAQ 说明，在免费托管运行时且没有正的 compute unit 余额时，把运行时主要当作远程 Web UI 使用属于受限活动，运行时可能随时终止；公开临时 URL 还会引入访问令牌、过期、跨域和大文件重试问题。只有用户明确使用允许该场景的付费资源并接受风险时，才能作为高级可选 provider。

### D. Colab 直接上传到 NotebookLM 的一次性上传会话（已选定）

当前 NotebookLM 适配器先在已登录页面创建来源，再取得 Google 可恢复上传 URL，最后上传文件字节。最有价值的优化是：

1. 插件在 NotebookLM 页面创建来源并申请与文件大小、MIME 对应的一次性上传会话。
2. 只把该受限上传 URL、文件元数据和任务 ID交给 Colab。
3. Colab 下载并校验 Facebook 媒体后，直接向 Google 上传会话发送 `upload, finalize`。
4. 插件只轮询来源状态和提取转录，不再接收视频 Blob。

这样媒体数据不会经过 Gradio/Cloudflare 隧道，也不会占用浏览器 512 MiB 缓冲。现场探针已在 `notebook.google.com` 完成验证：1 KiB MP3 使用 `credentials: omit` 向一次性上传地址执行 `upload, finalize`，返回 HTTP 200 和入队成功响应；随后临时来源删除成功。探针入口与动作已从生产构建移除，避免留下调试面。

该结果证明一次性上传地址不依赖浏览器会话 Cookie。正式实现仍必须遵守以下约束：

- 上传地址只在内存中短暂存在，不写日志、不写扩展存储、不显示在 UI，也不保存进笔记本源码。
- 控制面使用随机批次令牌，并只传任务状态、文件元数据和一次性上传地址；媒体字节不经过控制面。
- Colab 必须按插件提供的大小和 MIME 上传，完成后只回报状态；插件负责轮询 NotebookLM。
- 下载、媒体探测或上传失败时，插件删除已创建但未就绪的来源；重复任务必须使用新的来源和上传会话。
- 首版限制下载并发和待上传会话数量，避免数百个短期地址同时过期。

## 当前结论与实现顺序

主流程、临时 scratchpad、跨语言自动化选择器、双通道结构化事件、输入校验、错误分类、匿名 Facebook 下载、LocalTunnel 控制面和无 Cookie 的 Google 一次性上传会话均已完成现场验证。

2026-08-31 使用 Facebook 官方公开视频 `238358730483` 完成正式端到端测试：Colab 下载 62,267,083 字节 MP4，申请并使用一次性 Google 上传会话，NotebookLM 创建来源并返回完整英文转录，插件最终统计为总计 1、成功 1、失败 0；开启自动移除时来源随后删除。媒体字节全程不经过扩展内存或公网控制隧道。
