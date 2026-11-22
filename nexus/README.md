# NEXUS · 本机 AI 编排中枢（v0.6）

Windows 10 / 11 桌面应用：启动即自动识别本机所有可用 AI（本地推理引擎、宿主应用、MCP 工具服务、本机凭据云端通道），统一入口对话，用思维导图式画布编排多 AI 流程，并可手动接入任意模型 API、在通道失效时一键自愈。**v0.6 新增「用户优化中心」：功能投票 + 外观样貌/功能建议，一键汇总发送到产品团队邮箱（tianjinkang0130@sina.com）；v0.5 新增设置页「声音控制」，可一键静音/恢复当前正在发声的程序；同时把侧栏改成模型列表占满 + 底部横条输入框；v0.4 新增 AI 群聊与对话式插件安装；v0.3 起零配置即可用、每个 AI 节点都能说话。**

## 快速开始

```bash
# 方式一：纯 Node（无需安装任何依赖）
npm run web        # → http://127.0.0.1:8788

# 方式二：Electron 桌面窗口
npm i              # 仅安装 electron
npm start

# 打包单文件 exe
npm run dist:portable   # → dist/NEXUS-Portable-0.6.0.exe
```

要求：Node.js ≥ 20（仅 `npm run web` 模式）。

### 通过 npm 安装 / 分发

本仓库已是可发布 npm 包，包名为 `nexus-ai-orchestrator`（`nexus` 已被占用），并带 `nexus` 命令行入口：

```bash
# 全局安装（从源码目录）
npm i -g .

# 从 tarball / Git 仓库安装
npm i -g ./nexus-ai-orchestrator-0.6.0.tgz
npm i -g git+https://<your-repo>/nexus.git

# 安装后可用
nexus            # 启动 Web 服务（默认）
nexus web        # 同上
nexus desktop    # 启动 Electron 窗口（需已安装 electron）
nexus check      # 自检
nexus --version
```

打包产物：`npm pack` → `nexus-ai-orchestrator-0.6.0.tgz`。发布到公共 npm 仓库需先 `npm login`，再 `npm publish --access public`。

### 三平台安装包

官网 <https://ai-command-center.tianjinkang0130.workers.dev/> 的「下载安装」区提供三个平台的安装包：

| 平台 | 文件 | 构建命令 | 安装方式 |
| --- | --- | --- | --- |
| Windows 10/11 | `NEXUS-0.6.0-x64.exe`（安装版）、`NEXUS-Portable-0.6.0.exe`（便携版） | `npm run dist:win` | 双击安装 / 解压即用 |
| macOS 12+ | `NEXUS-0.6.0-arm64.zip`、`NEXUS-0.6.0-x64.zip` | `npm run dist:mac` | 解压后把 NEXUS.app 拖入「应用程序」 |
| Linux x86_64 | `NEXUS-0.6.0-x64-linux.tar.gz`（免安装）、`NEXUS-0.6.0-x64.deb` | `npm run dist:linux` + `node build/mac/make-deb.js` | 解压后运行 / `sudo dpkg -i` |

说明：macOS 包由 `build/mac/make-mac-app.js` 用 Electron 官方 darwin 二进制组装（Windows 上无法直接用 electron-builder 交叉构建 macOS），首次打开可能需要在「系统设置 → 隐私与安全性」中放行。所有安装包均为未签名构建。

**安装包安全边界（每个包都适用）**

- Windows 安装版与便携版都是当前用户级（`asInvoker` / `perMachine=false`），不请求管理员权限、不写系统目录、不改注册表启动项与系统 PATH；卸载只移除自身文件。
- macOS 是标准 `.app`，拖入「应用程序」即可，没有安装脚本、没有 launchd 服务。
- Linux `deb` 由 `build/mac/make-deb.js` 生成，只向 `/usr/share/nexus`、`/usr/bin/nexus`、`/usr/share/applications/nexus.desktop` 写文件，**不含任何 maintainer scripts**；`tar.gz` 解压即用。主程序与 `chrome-sandbox` 在打包时显式写入执行位（`0755` / `4755`），不会因 Windows 构建环境丢失权限而无法运行。
- 六个包都不含开机自启、计划任务、系统服务、浏览器主页/搜索引擎修改或第三方捆绑。
- 运行时的系统改动均可逆：自愈修复写 dsh 配置前生成时间戳备份；音频静音只作用于当前发声会话，软件正常退出或下次启动时按 SID 精确恢复；`pycaw` 等 Python 依赖只装进 `%APPDATA%\Nexus\pydeps`，不修改用户全局 Python 环境。

## 功能清单

**v0.1 基础能力**

- **启动自动识别**：并发扫描 Ollama / LM Studio / llama.cpp / vLLM / Jan / KoboldCpp / GPT4All / DeepSeek Harness 网关；识别 dsh、Claude Desktop 宿主应用；装载 WorkBuddy / Claude 的 MCP 服务清单；按需复用本机凭据注册云端通道。
- **侧边输入框**：全局常驻，自动路由或手动指定通道，逐字流式回复。
- **通话通道**：多 AI 圆桌，轮流 / 并行发言、多轮次、语音播报与波形可视化。
- **编排画布**：输入 / AI / 判断 / 循环 / 汇总五类节点，拖拽连线、缩放平移、属性面板、运行日志与流程落盘。

**v0.2 新增：模型接入与自愈**

- **模型接入中心**（左侧云形图标 / 顶栏「一键修复」）：手填名称、接口类型（OpenAI 兼容 / Ollama）、API 地址、模型清单路径、API Key 与默认模型；先「测试连接」拉取模型清单，再保存；支持编辑、删除、刷新模型、用已存密钥复测。提供 Moonshot / DeepSeek / 本机 Ollama / LM Studio / dsh 网关快速填充。
- **一键修复**：诊断自定义通道、dsh 配置、免费车道运行时、网关、钱包余额与 MCP 路径；可自动修复的问题立即修好并备份原文件，需要人工的逐条给出可执行建议；报告与最近 20 次修复记录可视化。「仅体检」为 dry-run，不修改任何文件。
- **报错即修**：对话失败的消息下方出现「一键修复并查看诊断」；设置里开启「报错时自动修复」后，失败会在后台自动跑一次诊断（90 秒内不重复），结果写回该条消息提示，不自动重发消息避免失败循环。

**v0.5 新增：系统声音开关 + 侧栏布局**

- **声音控制**（设置页）：实时列出本机所有音频会话，标出「正在发声」的程序（如 Edge 网页视频/音乐、微信内置播放器）。点「静音」会暂停当前正在发声的程序，点「恢复」原样还原；只改这些程序的静音状态，不改系统音量。实现上通过随包的 `server/audio_ctl.py`（pycaw / Windows Core Audio）精确控制到进程，需要本机有 Python 3 且可联网首次安装 pycaw；缺失时设置页会优雅提示，不影响其它功能。接口：`GET /api/audio`、`POST /api/audio/{toggle,mute,unmute}`。
- **侧栏布局**：工作对象列表占满侧栏全部高度；底部输入框改为横向长条（麦克风 / 输入 / 清空 / 发送同排）。
- **一键停止**：生成过程中「发送」自动变为「停止」（也可按 Esc）。点击后同时中断浏览器请求与本机上游推理，正文输出和 Ollama / 兼容接口的思考链（`thinking` / `reasoning`）都会立即停止；单聊、群聊、通话与画布流程均适用。服务端通过 `/api/chat/stop`、`/api/group/stop` 按 `requestId` 精确掐断对应流，不会误伤其它会话。
- **深度思考（DeepSeek 式思考）**：输入框上方有「深度思考」开关（设置页也有「深度思考（默认开启）」，两处同步）。开启后模型会像 DeepSeek 一样先思考再回答：消息里出现可折叠的「已深度思考（用时 X 秒）」面板，思维链逐字流式显示，思考完自动收起为一行，点标题可随时展开回看。服务端把请求级 `think:true` 传给 Ollama（`think` 参数）与 OpenAI 兼容接口（`enable_thinking`，不被支持时自动降级重试），兼容 DeepSeek 的 `reasoning_content`、`reasoning`、`thinking` 等多种思维链字段，并在 `done` 事件里回传完整思维链以便补全。未开启深度思考时，是否思考仍由设置页的本地思考链开关决定。

**v0.7 新增：全盘识别 + 模型/工具分类**

- **全盘识别**（「模型接入」页右上角「全盘识别」按钮）：直接扫描本机磁盘寻找 AI 模型，不再只依赖本地 HTTP 端口。能找到「装了但运行时没启动」的模型，包括：Ollama 通过 `OLLAMA_MODELS` 重定向到其它盘符的模型（读取 manifests 解析出 `qwen2.5:3b` 等）、独立的 `.gguf`/`.safetensors` 模型文件、LM Studio 与 HuggingFace 缓存。扫描结果按来源分组展示模型名、体积、速度等级与文件路径，并把「体积异常小」的占位文件单独标注、不计入可用模型。扫描只读文件、不执行任何模型或脚本，有深度/时间上限避免卡界面（`server/disk-scan.js`，接口 `POST /api/detect/deep`）。
- **随时更新模型数量**：每次「重新识别」都会跑一次快速磁盘扫描，模型总数即时刷新；「全盘识别」做深度扫描并把最新拓扑同步回主界面、侧栏与画布。
- **MCP 不再是模型**：MCP 工具服务与 dsh / Claude / WorkBuddy 宿主应用被明确归类为「工具与宿主服务」，在概览页单独分区展示，从侧栏模型列表与「模型总数」统计中移除。它们是供 AI 调用外部能力的工具或运行容器，本身不参与推理。

**v0.7.1 新增：软件自更新**

- **检查更新按钮**：设置页「软件更新」卡片与「帮助 → 检查更新」菜单都能检查官网新版本。发现新版本后展示版本号、发布日期与更新说明，点「下载并安装」即下载当前平台对应的安装包，带实时进度与取消；下载完成经 SHA256 校验后点「打开安装包」交给系统完成安装，重启软件即为新版。
- **安全边界**：更新清单来自官网 HTTPS（`version.json`）；下载文件名严格白名单、只写入 `%APPDATA%\Nexus\updates\`；校验 SHA256 与大小，不符即丢弃；页面不能直接执行文件，「打开安装包」由 Electron 主进程二次校验路径后交给系统。启动时会后台静默检查一次（可在设置里关闭），不打断使用。
- **发布新版本时**：把六个安装包放进 `dist/`，运行 `node build/make-version-json.js dist <官网目录>/version.json` 生成清单，重新部署官网即可；所有已发出去的客户端都能自动发现新版本。
- 接口：`GET /api/update/check`、`POST /api/update/download`、`GET /api/update/progress`、`POST /api/update/cancel`。

**v0.4 新增：AI 群聊 + 对话式插件安装**

- **AI 群聊**（左侧群聊图标）：像微信群聊一样，勾选多位 AI 成员、抛一个问题，系统自动分工处理，逐条呈现每个人的发言。三种协作模式随时切换：
  - **智能分工 + 汇总**（默认）：主持 AI 把问题拆成子任务分派给成员，各自处理后由主持人汇总结论；
  - **全员各自回答**：问题同时发给所有成员，并行作答；
  - **轮流接龙讨论**：成员依次发言，后面的人看到前面的观点再补充。
  群聊后端为每位成员复用此前的桥接与空响应回退能力，谁掉链子都不影响其他人。
- **对话式插件安装**：在对话里说一句「安装/下载 XX 插件」，系统自动识别意图、从内置白名单（filesystem / git / fetch / memory / sequential-thinking / puppeteer 等 11 款）匹配、把配置写进 WorkBuddy 的 `mcp.json`（写前备份）、后台预热下载并回报结果，点「重新识别」即可看到新插件挂载为 AI 节点。只接受白名单插件，不执行任意命令。
- **WorkBuddy 被识别**为宿主 AI 节点，概览与工作对象列表里可见（含 MCP 服务数与连接器数），选中后走桥接发言。

**v0.3 新增：免费模型 + 全 AI 可对话**

- **免费兜底模型**：内置一个免密钥的公共模型通道（NEXUS 免费模型，基于 Pollinations，需联网）。新机器零配置、或没有任何本地 / 自定义通道时，也能直接对话；设置里可关闭。自动路由优先级为「本地 → 免费 → 按量计费」。
- **每一个 AI 都能说话**：dsh / Claude Desktop 宿主、MCP 工具节点、当前离线的端点，乃至手输的不存在的通道，被选中后都由服务端自动桥接到在线模型发言，回复气泡标注「由 XXX 代答」。
- **空响应自动回退**：本机通道「显示在线却返回空文本」时会连续回退到下一个候选（免费通道优先），避免点了没反应的假在线状态。

## v0.6 新增：用户优化中心（功能投票 + 建议邮件）

左侧「心形」图标进入。所有用户都能参与产品共建：

- **功能投票**：内置外观样貌（主题配色、图标样貌、布局调整）与功能（语音、插件、导出、快捷键、云同步）等提案，点 ▲ 支持、▼ 撤回，按票数实时排序；也可输入自己想要的功能加入投票。
- **优化建议**：按「外观样貌 / 功能」分类填写具体建议，可留联系方式，保存在本机 `feedback.json`。
- **发送到邮箱**：点「发送到邮箱」会把投票结果与所有建议整理成邮件，发到产品团队邮箱 `tianjinkang0130@sina.com`：
  - 未配置发信邮箱时，自动打开本机邮件客户端并填好收件人、主题和正文（mailto 兜底，零配置可用）；也可「复制内容」手动粘贴。
  - 在「设置 → 反馈发信邮箱」填入自己的 SMTP 服务器、账号与授权码后，可一键直发（支持 SSL 465 / STARTTLS 587）。发信凭据只保存在本机，不上传。
- 服务端实现：`server/feedback.js`（投票/建议/邮件正文）、`server/smtp.js`（内置 SMTP 客户端，零第三方依赖）。接口：`GET /api/feedback`、`POST /api/feedback/{vote,idea,suggest,send}`、`GET /api/feedback/mailto`。

## 省额度（减少按量计费）

v0.3 默认采取以下策略，避免无谓消耗云端额度与积分：

1. **自动路由优先本地 / 免费**：Ollama、LM Studio、dsh 网关等零计费通道排在按量计费的云端 API 之前；其次用内置免费公共模型；只有这些都不可用时才走按量计费的云端。想强制使用某个云端模型时，在侧栏手动点选该通道即可覆盖。
2. **输出限长**：自动路由的对话默认把单次输出限制在 768 tokens；手动指定的通道不限制。
3. **探测缓存 2 分钟**：快照结果缓存 120 秒，避免每次刷新都去请求云端 `/models`。
4. **后台实例只留一个**：关闭多余的 NEXUS 窗口 / 服务，每个实例都会周期性探测端点。
5. **自动修复有节流**：报错触发的后台诊断 90 秒最多一次；「仅体检」不会发起写操作。
6. 建议在设置里按需关闭「启动时自动识别」，并把长文本、批量任务交给本地模型。

## 本地模型速度优化（无独显电脑）

纯 CPU 机器上 Ollama 慢的三个主因是：模型太大（超过内存会换页）、思考链、超大上下文。NEXUS 现在自动处理：

- **关思考链**：Ollama 请求默认带 `think:false`，qwen3 / qwen3.5 等推理模型不再先吐一大段思维链。实测 qwen3.5:4b 从 2.7 → 12 tokens/秒，提速约 4.5 倍。
- **限上下文**：默认 `num_ctx=4096`，避免 26 万 token 的默认窗口把 16GB 内存吃满。
- **智能选模型**（`server/model-picker.js`）：探测时给每个 Ollama 模型标注体积与速度等级（fast ≤3.5GB / medium ≤9GB / slow >9GB），按问题复杂度自动选：
  - 简单问题 → 小模型（如 `qwen2.5:3b`，约 12 tokens/秒）；
  - 复杂问题 → 内存安全范围内最强的模型；
  - 自动跳过超过物理内存的巨型模型（如 27B）；
  - 排除 <1GB 的玩具模型（虽快但回答不可靠）。
  - 回复气泡会显示「⚡ 简单问题 → 小模型快速响应」之类的标注，鼠标悬停可看详情。
- **设置页可覆盖**：「设置 → 本地模型速度」提供策略（自动 / 始终最快 / 始终高质量 / 固定模型 / 手动指定）、固定模型名、思考链开关、上下文窗口大小。

建议：无独显、16GB 内存的机器用 3B 级模型（如 `qwen2.5:3b`）；不要把 14B/27B 模型当日常对话模型。

## 本地接口（均只监听 127.0.0.1）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 版本、拓扑摘要、数据目录 |
| GET/POST | `/api/providers` / `/api/detect` | 读取 / 重跑自动识别（含快速磁盘扫描） |
| POST | `/api/detect/deep` | 全盘识别：扫描整台电脑寻找磁盘模型 |
| GET | `/api/update/check` | 检查官网新版本（对比 `version.json`） |
| POST | `/api/update/download` | 下载当前平台安装包（后台任务，返回 jobId） |
| GET | `/api/update/progress` | 查询下载进度 |
| POST | `/api/update/cancel` | 取消下载 |
| POST | `/api/chat` | SSE 流式对话 |
| GET/POST | `/api/settings` | 读写设置（含自动修复开关） |
| GET/POST | `/api/flows` | 读写画布流程 |
| GET/POST | `/api/custom-providers` | 列出 / 新增自定义通道 |
| POST | `/api/custom-providers/probe` | 只测不存 |
| PUT/DELETE | `/api/custom-providers/:id` | 更新 / 删除通道 |
| POST | `/api/custom-providers/:id/refresh` | 重新拉取模型清单 |
| POST | `/api/custom-providers/:id/test` | 用已保存的密钥原地复测 |
| POST | `/api/repair` | `{"auto":true}` 修复 / `false` 仅体检 |
| GET | `/api/repair/history` | 最近 20 次修复记录 |

## 目录结构

```
nexus/
├── electron/          # 主进程壳（main.js / preload.js）
├── server/            # index.js 路由 · detector.js 探测 · providers.js 推理适配
│                      # custom.js 自定义接入 · repair.js 自愈 · probe.js · store.js
├── renderer/          # index.html + css/ + js/（hub.js 为接入与修复面板）
└── docs/ARCHITECTURE.md   # 架构、模块划分、界面布局说明
```

## 安全边界

- 服务只绑定 `127.0.0.1`，不对外监听。
- 自动识别的云端通道不复制、不落盘任何 API Key，按需从原应用凭据位置读取。
- 手动接入的 Key 只写在 `%APPDATA%\Nexus\custom-providers.json`，界面永远只显示掩码；编辑时留空表示沿用旧值；复测接口不回传明文。
- 自动修复改写 dsh 配置前会生成 `.bak-时间戳` 备份，可随时回滚；欠费、密钥失效、需安装运行时等只给建议，不擅自操作账户。
- 画布条件表达式在本机执行，仅作用于本地流程数据。
