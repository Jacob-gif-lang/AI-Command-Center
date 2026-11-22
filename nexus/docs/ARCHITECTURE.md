# NEXUS 架构说明（v0.6）

> 面向 Windows 10 / 11 的本机 AI 编排中枢：启动即识别本机所有可用 AI，统一入口对话，
> 提供思维导图式画布编排多 AI 流程，并支持手动接入任意模型 API 与故障自愈。
> v0.3 起零配置即可用（内置免费模型），且界面上每一个 AI 节点都能说话。

## 0.6 v0.6 增补（用户优化中心：功能投票 + 建议邮件）

新增一个用户共建模块，前后端各加两个文件，不触碰既有对话/推理链路：

```
renderer/js/feedback.js ──> /api/feedback* ──> server/feedback.js ──> feedback.json
                                                    │
                                                    └──> server/smtp.js ──> tianjinkang0130@sina.com
renderer/css/feedback.css   （视图样式）
renderer/index.html         （rail 心形按钮 + data-view="feedback" 视图 + 设置页 SMTP 区块）
```

- `server/feedback.js`：投票/提案/建议的增删与本地持久化（`%APPDATA%\Nexus\feedback.json`），并负责把投票结果 + 建议拼成邮件正文；内置 8 条默认提案，支持用户自定义提案。
- `server/smtp.js`：零依赖 SMTP 客户端（Node 内置 `net`/`tls`），支持 SSL 465 与 STARTTLS 587，正文用 base64 + UTF-8 头避免中文乱码。
- 邮件双通道：设置里配了 SMTP 就直发；否则 `/api/feedback/mailto` 返回 mailto URL，由本机邮件客户端接管，`renderer` 里「复制内容」作为兜底。
- 相关接口：`GET /api/feedback`、`POST /api/feedback/vote`、`POST /api/feedback/idea`、`POST /api/feedback/suggest`、`POST /api/feedback/send`、`GET /api/feedback/mailto`。

## 0.5 v0.5 增补（系统声音开关 + 侧栏布局）

声音控制链路（只影响当前正在发声的进程，不改系统音量）：

```
renderer/js/sound.js ──> GET /api/audio ──> server/audio.js
                       ──> POST /api/audio/toggle ──> server/audio_ctl.py（pycaw / Core Audio）
                                                     └── SetMute(1/0) 到 ACTIVE 会话，SID 记入 %APPDATA%\Nexus\audio-state.json
```

- `server/audio.js`：child_process 调 Python，多路径探测解释器并缓存到 `python-path.json`；缺 pycaw 时尝试自动 `pip install` 一次，全失败则向 UI 返回 `python_not_found` 优雅降级。
- `server/audio_ctl.py`：枚举会话（pid/进程名/状态/静音/音量/SID），`mute` 只静音 ACTIVE 且未静音者并记录 SID，`unmute` 按 SID 精确还原，`toggle` 智能切换。
- 前端设置页每 5 秒刷新一次会话状态；`NEXUS_PYTHON` 环境变量可手动指定解释器路径。

## 0.4 v0.4 增补（AI 群聊 + 对话式插件安装）

新增两个协作单元：

```
renderer/js/group.js ──SSE──> /api/group ──> server/group.js（群聊编排）
                                              └── 复用 providers.streamChat + free 桥接/回退
对话输入 ──> /api/chat（意图检测）──> server/plugins.js（白名单安装 → 写 mcp.json → 后台预热）
```

- **群聊引擎 `group.js`**：三种模式 —— `broadcast`（Promise.all 全员并发）、`relay`（串行、把前面发言注入后续上下文）、`delegate`（主持 AI 输出 JSON 分派单 → 归一化 → 成员并发执行 → 主持汇总）。每位成员经统一的 `speak()` 发言，内部复用“被请求节点 → 免费 → 其它在线通道”的候选回退，空响应自动换人。SSE 事件：`group_start / message_start / message_done / message_error / plugin / group_done`，前端 `group.js` 按 mid 逐条渲染微信群聊式气泡，支持主持人/成员/汇总标签与代答标注。
- **插件安装 `plugins.js`**：内置 11 款 MCP 白名单目录（id/别名/npm 包/启动参数/说明）。`detectIntent()` 从自然语言里识别安装意图并匹配插件；`install()` 写前备份 `~/.workbuddy/mcp.json`、追加 `npx -y <pkg>` 启动项、后台 `exec` 预热下载、回报结果并触发拓扑重扫。只接受白名单，绝不执行用户提供的任意命令。`/api/chat` 在推理前检测意图，推 `plugin` 事件并把结果注入模型上下文让其自然语言确认。
- **WorkBuddy 宿主识别**：`detector.detectApps()` 新增 `~/.workbuddy` 扫描，读取 mcp.json 服务数与 connectors 目录数，注册为 `workbuddy` 节点（`isBridge`），选中走桥接发言。
- **前端**：新增 `data-view="group"` 视图、`group.css`（成员 chip / 群聊气泡 / 系统回执）、`group.js`（成员勾选、模式切换、SSE 渲染）；`app.js` 路由与发送分流到群聊；`views.js` 支持 system 回执消息；`api.js` 新增 `group()` / `listPlugins()` / `installPlugin()` 与 `chat` 的 `onPlugin` 回调。

## 0.3 v0.3 增补（免费模型 + 发言人桥接）

新增一个协作单元：

```
server/free.js ──> detector.js（注入免费通道）
               └──> server/index.js handleChat（发言人候选 + 空响应回退）
```

- **免费兜底 `free.js`**：静态定义免密钥公共通道 `free:pollinations`（Pollinations OpenAI 兼容端点），`inject()` 在 `detect()` 组装拓扑时无条件混入（设置 `freeFallback=false` 可关）。它不参与探测握手（零额外请求、不消耗任何密钥额度），始终 `online`，保证新机器零配置也有真实模型。自动路由评分：本地 −5000、免费 −2000、聚合器 +60，因此顺序恒为「本地 → 免费 → 按量计费」。
- **发言人桥接**：`handleChat` 不再因 `chatCapable=false` / 通道离线 / id 不存在而拒绝。`speakerCandidates()` 生成候选序列（被请求节点自己 → 免费通道 → 其它在线通道，去重、最多 4 个）；逐个调用 `streamChat`，遇到**空文本且无增量**或异常就在客户端尚未看到半成品时安全回退到下一个候选，直到拿到内容。SSE `meta` 事件携带 `bridge{requestedName,speakerName,reason}`，前端在回复气泡标注「由 XXX 代答」。
- **前端联动**：`views.renderTargets()` 移除 `data-disabled`，app/MCP 节点显示为 `APP·桥接` / `MCP·桥接` 且可点选；`state.autoPick()` 认识 `free` cap；`api.chat()` 把 `meta.bridge` 回传给 `onMeta`；设置新增 `freeFallback` 开关（`store.js` 默认 true），改动后立即重扫拓扑。

## 0. v0.2 增补（模型接入与自愈）

基础架构不变，新增三个协作单元：

```
renderer/js/hub.js ──HTTP──> server/index.js 路由
                              ├── server/custom.js   自定义通道 CRUD + 握手
                              ├── server/probe.js    共享 HTTP 探测原语
                              └── server/repair.js   诊断 + 可回滚修复
                                    └── server/store.js  custom-providers.json / repair-log.json
```

- **自定义接入层 `custom.js`**：把用户填写的「名称 / 类型 / API 地址 / 清单路径 / Key / 默认模型」落盘到 `%APPDATA%\Nexus\custom-providers.json`；保存前用 `/models`（Ollama 用 `/api/tags`）握手；`toProvider()` 把记录归一化为标准 Provider，混入 `detector.js` 的拓扑快照，因此侧栏、对话、画布、通话通道自动获得新通道。渲染层只拿到掩码密钥，复测接口用服务端保存的密钥原地握手，不回传明文。
- **自愈引擎 `repair.js`**：诊断分「可自动修复（auto，改配置前必备份）」与「需人工（manual，只给建议）」两档。覆盖自定义地址漏 `/v1`、dsh 的 Moonshot 站区错配、模型 `maxTokens == contextWindow` 导致输入预算为 0、dsh 默认模型失效、免费车道缺 Bun、网关未启动、聚合钱包欠费、MCP 程序路径失效等。返回 `findings[] / fixedCount / manualCount / needRestart / changedFiles`，前端逐条渲染。
- **前端 `hub.js` + `hub.css`**：独立命名空间的接入中心视图（新增通道表单 / 快速填充 / 已接入列表 / 诊断报告 / 修复记录）。对话失败时消息下方出现「一键修复」；设置项 `autoRepairOnError` 控制后台自动自愈，90 秒节流、不自动重发。

**省额度策略**：自动路由优先本地 / 免费通道（按量计费通道加权惩罚，手动选通道可覆盖）、自动路由输出限 768 tokens、拓扑快照缓存 120 秒减少云端 `/models` 探测、后台诊断 90 秒节流。

---

## 1. 总体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  Electron 壳（electron/）                                             │
│  main.js  起本地服务 → 开 BrowserWindow（隐藏式标题栏）                 │
│  preload.js 只暴露只读宿主信息（contextIsolation 开启）                │
└───────────────┬──────────────────────────────────────────────────────┘
                │ 加载 http://127.0.0.1:8788（唯一通信面）
┌───────────────▼──────────────────────────────────────────────────────┐
│  渲染层（renderer/） —— 无框架、无构建步骤，纯 ES5 脚本                  │
│  views.js  状态 → DOM 映射（概览 / 对话 / 通话 / 设置）                  │
│  canvas.js 思维导图画布：节点拖拽、贝塞尔连线、缩放平移、属性面板          │
│  engine.js 流程执行引擎：深度优先 + 判断分流 + 循环回边识别               │
│  app.js   路由、对话、通话通道（Web Speech + speechSynthesis）、设置      │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTP + SSE（/api/*，仅 127.0.0.1 回环）
┌───────────────▼──────────────────────────────────────────────────────┐
│  本地服务层（server/）—— Node 20+，零第三方依赖                        │
│  index.js     HTTP 服务：静态资源 / REST / SSE / 端口仲裁               │
│  detector.js  探测层：端点扫描 + 应用识别 + MCP 清单 + 凭据复用          │
│  providers.js 适配层：ollama / openai / demo 三类协议归一为一条流         │
│  store.js     持久化：%APPDATA%\Nexus（settings / flows / snapshot）    │
└──────────────────────────────────────────────────────────────────────┘
```

**关键设计决策**

| 决策 | 理由 |
|---|---|
| 渲染层 ↔ 后端统一走 HTTP + SSE，不用 IPC | 同一份代码可跑在 Electron、纯 Node（`npm run web`）与浏览器预览三种宿主；SSE 天然适配逐字流式；后续手机/平板可连同一端口 |
| 主进程零业务逻辑 | 业务全部在 server/ 与 renderer/，Electron 只是壳，方便将来换 Tauri/WebView2 |
| 零 npm 依赖（Electron 除外） | detector/providers 用 Node 内置 fetch；不引入框架，首屏 < 50ms，也无供应链风险 |
| 密钥不落盘、不复制 | 云端通道按需从原应用凭据位置（如 `%USERPROFILE%\.dsh\.credentials.yaml`）读取，只在本机回环内使用 |
| 流程引擎 v0.1 放渲染层 | 节点执行需要实时驱动 UI（高亮/逐字/连线动画）。事件契约（node-start/delta/done/error/edge-active）保持稳定，v0.2 可原样搬进 server/ 变成「关窗继续跑」的后台编排 |

---

## 2. 模块划分

### 2.1 探测层 `server/detector.js`

启动（或手动刷新）时并发执行五条流水线，输出统一的 Provider 描述：

| 流水线 | 做什么 | 典型产出 |
|---|---|---|
| 端点扫描 | 握手 11434 / 1234 / 1337 / 8080 / 8000 / 5001 / 4891 / 8326 等本地端口并拉模型列表 | Ollama、LM Studio、llama.cpp、vLLM、DeepSeek Harness 网关 |
| 应用识别 | 检查 `~/.dsh`、`AppData\Local\Claude-Data` 等安装痕迹 | DeepSeek Harness（APP）、Claude Desktop（APP） |
| MCP 装载 | 解析 WorkBuddy / Claude Desktop / Cursor 的 `mcp.json` | windows-mcp 等工具服务（MCP） |
| 凭据复用 | 从本机既有凭据按名字提取密钥并轻探测 | Moonshot/Kimi、DeepSeek 开放平台、TeamoRouter（云端通道） |
| 归一化 | 全部映射为 `{ id, kind, status, endpoint, models[], caps[], latencyMs }` | 供路由层与画布节点选择 |

状态语义：`online`（可对话）/ `restricted`（通道在但额度/权限受限）/ `installed`（宿主应用，不直接对话）/ `configured`（MCP 已登记）/ `offline`。

### 2.2 适配层 `server/providers.js`

- `ollama` → `POST /api/chat`（NDJSON 流）
- `openai` → `POST /v1/chat/completions`（SSE 流），并处理两类现实问题：
  - 部分模型（kimi-k2.6）只接受固定 temperature → 默认不传，被拒后按提示值重试一次；
  - 思维链模型的 `reasoning_content` 与正文分离 → 分开累积，正文为空时降级输出思维链。
- 错误分类器把上游报错翻译成人话 + 处置建议（`insufficient_balance` → 去充值、`unauthorized` → 重新登录、`missing_runtime` → 装运行时）。
- `demo` 适配器：无任何可用后端时提供模拟流，保证 UI 永远可演示。

### 2.3 服务层 `server/index.js`

- 端口仲裁：8788 → 8790 → 9315 → 随机，绑定 127.0.0.1，不对外。
- 接口：
  - `GET  /api/health`、`GET/POST /api/providers?refresh=1`、`POST /api/detect`
  - `POST /api/chat`（SSE：`meta` / `delta` / `thinking` / `done` / `error`）
  - `GET/POST /api/settings`、`GET/POST /api/flows`
- 15 秒探测快照缓存 + 并发去重（同一时刻只跑一次全量扫描）。

### 2.4 画布 `renderer/js/canvas.js`

- 世界坐标 + CSS transform 缩放平移；节点为绝对定位 DOM，连线为 SVG 贝塞尔曲线。
- 端口语义（即连线出口语义）：

| 节点 | 入口 | 出口 |
|---|---|---|
| 输入 | — | `out` |
| AI | `in` | `out` |
| 判断 | `in` | `true`（绿）/ `false`（红虚线） |
| 循环 | `in` | `body`（粉虚线，接循环体）/ `exit`（绿） |
| 汇总 | `in` | — |

- 交互：拖节点、从端口拖出连线、双击空白加 AI 节点、滚轮缩放、Delete 删选中、右侧属性面板改通道/模型/提示词/条件、流程落盘到 `%APPDATA%\Nexus\flows.json`。

### 2.5 流程引擎 `renderer/js/engine.js`

- 深度优先遍历；判断节点按 `result / round / input` 表达式（本机执行）走单分支。
- 循环节点：对 `body` 分支迭代 N 轮；**回边（循环体终点指回循环节点）被识别为一次迭代结束**，不会死循环；另有最大步数熔断（默认 200）。
- 事件流：`flow-start / node-start / node-delta / node-done / node-error / edge-active / flow-output / flow-done / flow-error`，画布据此做节点高亮、连线流光、执行日志。

### 2.6 通话通道 `app.js`

- 多 AI 圆桌：选参与者 → 设轮次与模式（轮流发言 / 并行抢答）→ 逐字流入转录区。
- 语音：识别用 Web Speech API（侧栏麦克风按钮），播报用 `speechSynthesis`（可关）。
- 波形为装饰性可视化，发言时振幅抬高。

---

## 3. 核心界面布局

```
┌──┬──────────────────┬──────────────────────────────────────────────┐
│R │ 侧栏（336px）      │ 主区                                          │
│A │ ─────────────    │ ┌──────────────────────────────────────────┐ │
│I │ NEXUS v0.1       │ │ 顶栏：面包屑 · 状态 pills · 重新识别        │ │
│L │ ● 3 个在线·14 对象│ ├──────────────────────────────────────────┤ │
│  │ ─────────────    │ │ 视图区（五个互斥视图）                      │ │
│概│ 工作对象          │ │  ① 概览：指标卡 + Provider 网格 + 流水线    │ │
│览│  ● Ollama  3模型  │ │  ② 对话：通道 chips + 消息流               │ │
│  │  ● Harness 142   │ │  ③ 画布：工具栏 + 无限画布 + 属性面板+日志  │ │
│对│  ● Kimi  6 模型   │ │  ④ 通话：参与者 + 波形舞台 + 转录 + 控制   │ │
│话│  ○ APP / MCP…    │ │  ⑤ 设置：识别与路由 / 本机数据 / 关于       │ │
│  │ ─────────────    │ └──────────────────────────────────────────┘ │
│画│ 节点库（仅画布）   │                                              │
│布│ ─────────────    │                                              │
│通│ ┌──────────────┐ │                                              │
│话│ │ 侧边输入框 ✦  │ │  ← 全局常驻：普通视图=提问，                   │ │
│设│ │ AUTO/CALL/FLOW│ │     画布视图=流程 {{input}}，通话=开场白        │ │
│置│ └──────────────┘ │                                              │
└──┴──────────────────┴──────────────────────────────────────────────┘
```

- **一级图标栏（64px）**：概览 / 对话 / 画布 / 通话 / 刷新 / 设置，激活态渐变光条。
- **二级侧栏**：工作对象列表（点击即切换对话目标）＋ 节点库（仅画布视图）＋ **全局常驻输入框**（Enter 发送、Shift+Enter 换行、Ctrl+K 聚焦）。
- **视觉语言**：近黑底 + 双色光晕背景 + 玻璃拟态面板 + 1px 发丝边框；强调色 `#7b5cff → #22d3ee` 渐变；全部尺寸走 8pt 栅格，深色单主题。

---

## 4. 数据流（一次提问的完整路径）

```
侧边输入框 → app.send() → 路由（手动选中 or 自动挑选在线低延迟本地通道）
  → POST /api/chat (SSE) → providers.streamChat()
  → ollama / openai 兼容端点（流式）
  → delta/thinking/done 事件 → 渲染层逐字上屏 → 消息历史保留 12 轮上下文
```

一次画布运行的路径：

```
运行按钮 → engine.runFlow(flow, { input: 侧边输入框内容 })
  → input → ai(真实调用) → judge(表达式) → loop(body 回边 × N) → output
  → 每个事件驱动节点高亮/连线流光/执行日志
  → flow-output 写回对话视图，可继续追问
```

---

## 5. 运行方式

```bash
npm run web    # 纯 Node 模式，浏览器打开 http://127.0.0.1:8788（无需 Electron）
npm start      # Electron 桌面窗口（需先 npm i 安装 electron）
npm run check  # 探测自检
```

## 6. v0.2 路线

- 流程引擎下沉到主进程（SSE 推事件），支持「关掉窗口继续跑」与定时触发；
- MCP stdio 直连：把 windows-mcp 等工具节点真正挂进画布（当前只做登记展示）；
- 流程模板市场 / 分享（flows.json 已结构化，可直接导入导出）；
- 打包：electron-builder 出 NSIS 安装包 + 开机自启托盘常驻。
