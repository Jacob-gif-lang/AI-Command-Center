'use strict';
/**
 * 轻量国际化层。
 * 源码中的中文文案保持原样，本模块在运行时把 DOM 里的文本/属性翻译成目标语言，
 * 通过 MutationObserver 覆盖所有动态渲染（消息、状态、提示等），无需改动各业务模块。
 * 语言偏好写入 localStorage 与后端设置，切换即时生效、可来回切换。
 */
(function (root) {
  const ZH = 'zh', EN = 'en';
  const KEY = 'nexus.lang';

  /* ---------------- 精确匹配词典（中文 -> 英文） ---------------- */
  const DICT = {
    // 通用 / 导航
    '概览': 'Overview', '对话': 'Chat', 'AI 群聊': 'AI Group Chat', '群聊': 'Group Chat',
    '编排画布': 'Flow Canvas', '画布': 'Canvas', '通话通道': 'Call Channel', '通话': 'Call',
    '模型接入': 'Model Hub', '接入': 'Integration', '用户优化': 'User Voice', '设置': 'Settings',
    '本机 AI 拓扑': 'Local AI Topology', '单通道提问': 'Single-channel chat',
    '多人自动协作': 'Multi-AI collaboration', '多 AI 流程': 'Multi-AI workflow',
    '多 AI 圆桌': 'Multi-AI roundtable', 'API 与自愈修复': 'API & self-healing repair',
    '功能投票与建议': 'Feature voting & suggestions', '识别与路由': 'Detection & routing',
    '工作对象': 'Work Targets', '节点库': 'Node Library',
    '重新识别本机 AI': 'Re-detect local AI', '重新识别': 'Re-detect', '设置': 'Settings',
    '一键修复': 'One-Click Repair', '诊断并自动修复不可用的通道': 'Diagnose & auto-repair unavailable channels',
    '正在识别本机 AI…': 'Detecting local AI…', '正在识别…': 'Detecting…', '检测中…': 'Detecting…',
    '概览': 'Overview', '发送': 'Send', '停止': 'Stop', '语音输入': 'Voice input',
    '清空会话': 'Clear conversation', '提问 · 自动路由': 'Ask · Auto routing',
    '流程输入 · 作为 {{input}}': 'Flow input · as {{input}}',
    '通话开场白 · Enter 开始': 'Call opener · Enter to start',
    '群聊发言 · 自动分配': 'Group message · auto assign',
    '像 DeepSeek 一样展示模型的思考过程': 'Show the model\'s reasoning like DeepSeek',
    '深度思考': 'Deep Thinking', '提问… Enter 发送': 'Ask… Enter to send',
    '停止输出与思考': 'Stop output & reasoning', '生成中 · 可随时停止': 'Generating · can stop anytime',

    // 侧栏节点库
    '输入节点': 'Input Node', 'AI 节点': 'AI Node', '判断节点': 'Decision Node',
    '循环节点': 'Loop Node', '汇总节点': 'Aggregate Node',
    '流程起点': 'Flow start', '调用一条通道': 'Calls one channel',
    '按结果分流': 'Branch by result', '迭代直到满足条件': 'Iterate until condition met',
    '收敛输出': 'Converge outputs',

    // 概览页
    'LOCAL AI MESH · 启动即完成识别与配置': 'LOCAL AI MESH · detection & setup done at startup',
    '把本机散落的 AI': 'Bring every local AI',
    '接成一张可编排的网': 'into one orchestrable network',
    '自动发现 Ollama、LM Studio、DeepSeek Harness、Claude Desktop、MCP 工具服务与本机凭据通道；统一入口提问，或在画布上把它们的流程连起来。':
      'Auto-discovers Ollama, LM Studio, DeepSeek Harness, Claude Desktop, MCP tool services and local credential channels. Ask from one place, or wire their flows on the canvas.',
    '已识别的 AI 模型与通道': 'Detected AI Models & Channels',
    '工具与宿主服务': 'Tools & Host Services',
    '非模型 · 供 AI 调用或作为容器': 'Not models · callable tools or containers',
    '识别流水线': 'Detection Pipeline', '启动时自动执行，可随时重跑': 'Runs at startup, re-runnable anytime',
    '在线对象': 'Online objects', '可对话通道': 'Chat-ready channels', '模型总数': 'Total models',
    '毫秒': 'ms', '在线': 'Online', '可对话': 'Chat-ready', '模型': 'Models',
    '工具': 'Tools', '工具服务': 'Tool service', '握手': 'Handshake',
    'MCP 工具': 'MCP Tool', '宿主应用': 'Host App',
    '未发现任何 AI 模型。请确认本机 AI 已启动，或点击「全盘识别」扫描磁盘。':
      'No AI models found. Make sure a local AI is running, or click "Full Disk Scan".',
    '未检测到 MCP 工具或宿主应用。它们不是模型，只是供 AI 调用的外部工具或运行容器。':
      'No MCP tools or host apps detected. These are not models — just external tools or containers for AI to call.',
    '不计入模型总数': 'not counted toward model total',
    '端点扫描': 'Endpoint scan', '并发握手 11434 / 1234 / 8080 / 8000 / 8326 等常见本地端口':
      'Concurrent handshake on common local ports 11434 / 1234 / 8080 / 8000 / 8326',
    '应用识别': 'App detection', '读取 .dsh、Claude-Data 等安装痕迹，判定宿主应用是否存在':
      'Reads .dsh, Claude-Data and other traces to detect host apps',
    'MCP 装载': 'MCP loading', '解析 WorkBuddy / Claude Desktop 的 mcp.json，登记工具服务':
      'Parses mcp.json from WorkBuddy / Claude Desktop and registers tool services',
    '凭据复用': 'Credential reuse', '按需读取本机既有凭据，注册云端通道（不复制、不落盘）':
      'Reads existing local credentials on demand to register cloud channels (no copy, no disk write)',
    '通道注册': 'Channel registration', '归一化为统一 Provider 描述，写入画布节点可选的通道列表':
      'Normalizes into unified provider descriptions for canvas node selection',
    '桥接发言 · 自动选在线模型': 'Bridged reply · auto-selects an online model',
    '自动路由': 'Auto routing', '未选择通道': 'No channel selected',

    // 对话页
    '向本机任意一条通道开口': 'Talk to any local channel',
    '左侧输入框直接提问，NEXUS 会按当前选中的 AI 发送；没有手动选择时走自动路由（优先在线、低延迟的本地通道）。':
      'Type in the input box on the left; NEXUS sends to the selected AI, or auto-routes (preferring online, low-latency local channels) if none is selected.',
    '你': 'You', '已深度思考': 'Deep thinking complete', '正在深度思考…': 'Thinking deeply…',
    '思考中': 'Thinking', '一键修复并查看诊断': 'Repair & view diagnostics',
    '由': 'Answered by', '代答': '', '该节点已自动桥接到在线通道': 'This node was auto-bridged to an online channel',
    '智能选模型': 'Smart model pick', '复杂度': 'Complexity',
    '已停止输出': 'Output stopped', '已停止思考': 'Reasoning stopped',
    '上游返回了空响应。': 'The upstream returned an empty response.',
    '插件操作完成': 'Plugin action completed', '调用失败：': 'Call failed: ',
    '正在后台自动诊断与修复…': 'Auto-diagnosing & repairing in background…',
    '自动诊断失败，请到「模型接入」页手动点「一键修复」。': 'Auto-diagnosis failed. Open "Model Hub" and click "One-Click Repair".',
    '诊断发现': 'Diagnosis found', '项需手动处理': 'items need manual handling',
    '自动体检未发现可修复问题，建议换一条通道重试': 'No fixable issues found; try another channel',
    '（部分改动需重启 DeepSeek Harness）': '(Some changes require restarting DeepSeek Harness)',
    '详情见「模型接入」页': 'See "Model Hub" for details',
    '自动诊断未完成，可点下方「一键修复」': 'Auto-diagnosis incomplete; click "One-Click Repair" below',
    '上一条还在回复中': 'A reply is still in progress',
    '没有可用通道，先在概览里确认本机 AI 是否启动': 'No channel available; check on Overview that a local AI is running',
    '用一句话说明你现在能做什么': 'In one sentence, what can you do now',
    '把本机所有可用模型列出来': 'List all available local models',
    '帮我规划一个多 AI 协作流程': 'Help me plan a multi-AI workflow',

    // 通话
    'CALL CHANNEL · 多 AI 圆桌': 'CALL CHANNEL · Multi-AI roundtable',
    '选择一个或多个参与者，开始后依次发言，可实时插话。': 'Pick one or more participants; they speak in turn and you can interject live.',
    '待机': 'Standby', '开始通话': 'Start Call', '挂断': 'Hang Up', '轮次': 'Rounds',
    '模式': 'Mode', '轮流发言': 'Sequential', '并行抢答': 'Parallel', '语音播报': 'Speak aloud',
    '通话进行中': 'Call in progress', '先在上方选至少一个参与者': 'Select at least one participant above',
    '通话中': 'In call', '通话结束': 'Call ended', '已挂断': 'Hung up', '无内容': 'No content',
    '请用一句话说明你能为这次协作贡献什么，并给一个具体建议。': 'In one sentence, what can you contribute to this collaboration, and give a concrete suggestion.',

    // 群聊
    'GROUP CHAT · 多 AI 群聊': 'GROUP CHAT · Multi-AI group chat',
    '发一个问题，自动分配给多位 AI 各自处理。像微信群聊一样逐条呈现。':
      'Ask one question; it is auto-assigned to multiple AIs and shown message by message, like a group chat.',
    '协作模式': 'Collaboration Mode', '智能分工 + 汇总': 'Smart delegation + summary',
    '全员各自回答': 'Everyone answers', '轮流接龙讨论': 'Relay discussion', '清屏': 'Clear',
    '把问题丢进群里': 'Throw a question into the group',
    '上方勾选参与的成员（至少 2 位效果更佳），选择协作模式，然后在下面发言。AI 们会自动分工、各自回答。':
      'Tick members above (2+ works best), pick a mode, then speak below. The AIs will divide work and answer.',
    '向群里发一个问题…（Enter 发送，Shift+Enter 换行）': 'Ask the group… (Enter to send, Shift+Enter for newline)',
    '暂无可对话的 AI，请先启动本机模型或点「重新识别」': 'No chat-ready AI; start a local model or click "Re-detect"',
    '主持人': 'Host', '汇总': 'Summary', '成员': 'Member', '任务：': 'Task: ',
    '（已停止）': ' (stopped)', '已停止输出与思考': 'Output & reasoning stopped',
    '群聊进行中，请稍候': 'Group chat in progress, please wait',
    '请先在上方选择至少一位群成员': 'Select at least one group member above',
    '群聊进行中…': 'Group chat running…', '位成员已就位': 'members ready',
    '发言失败：': ' failed to respond: ', '未知错误': 'Unknown error',
    '群聊出错': 'Group chat error', '群聊完成': 'Group chat complete',
    '群聊中断': 'Group chat interrupted', '群聊连接失败：': 'Group chat connection failed: ',
    '帮我规划一个多 AI 协作方案': 'Help me plan a multi-AI collaboration',
    '分析一下本地模型的优缺点': 'Analyze the pros and cons of local models',
    '用一个问题测试各位的能力': 'Test everyone\'s ability with one question',

    // 画布
    '输入': 'Input', '判断': 'Decision', '循环': 'Loop', '汇总': 'Aggregate',
    '主流程': 'Main Flow', '用户提问': 'User Question', '流程入口': 'Flow entry',
    '主答 · 自动路由': 'Main answer · auto routing', '答案是否够长': 'Is the answer long enough',
    '补充迭代': 'Refinement loop', '扩写节点': 'Expand node', '结果汇总': 'Result summary',
    '在下面内容基础上补充两个要点：\n{{last}}': 'Add two key points based on the content below:\n{{last}}',
    '流程起点': 'Flow start', '自动路由（推荐）': 'Auto routing (recommended)',
    '默认模型': 'Default model', '自动': 'Auto', '默认': 'Default',
    '（未设置提示词）': '(no prompt set)', '条件：': 'Condition: ',
    '真 → 上端口 · 假 → 下端口': 'True → upper port · False → lower port',
    '最多': 'Max', '轮': ' rounds', '退出：': 'Exit: ', '跑满轮次后退出': 'Exit after all rounds',
    '合并策略：': 'Merge strategy: ', '收束全流程输出': 'Collect all flow output',
    '循环体': 'Loop body', '退出': 'Exit', '输出': 'Output', '真': 'True', '假': 'False',
    '删除节点': 'Delete node', '节点': 'Nodes', '连线': 'Connections', '缩放': 'Zoom',
    '入口标签': 'Entry label', '通道': 'Channel', '模型': 'Model', '提示词': 'Prompt',
    '支持 {{input}} 与 {{last}}': 'Supports {{input}} and {{last}}',
    '{{input}} = 本轮用户输入；{{last}} = 上游节点输出': '{{input}} = current user input; {{last}} = upstream node output',
    '系统约束': 'System constraints', '可选': 'Optional', '判断条件': 'Condition',
    '可用 result / round / input，例如 result.length > 80': 'Use result / round / input, e.g. result.length > 80',
    '真 → 上端口；假 → 下端口。条件表达式在本机执行。': 'True → upper port; False → lower port. Conditions run locally.',
    '最大轮次': 'Max rounds', '退出条件': 'Exit condition', '留空则跑满轮次；expression 同判断节点':
      'Leave blank to run all rounds; expression like the decision node',
    '取最后一个节点输出': 'Take last node output', '拼接全部输出': 'Concatenate all outputs',
    '节点名称': 'Node name', '流程开始': 'Flow started', '流程完成': 'Flow completed',
    '流程失败：': 'Flow failed: ', '已停止输出与思考': 'Output & reasoning stopped',
    '画布是空的，先添加节点': 'Canvas is empty; add a node first',
    '运行中': 'Running', '运行流程': 'Run Flow', '用三句话说明你能做什么': 'In three sentences, what can you do',
    '双击空白处添加 AI 节点': 'Double-click empty space to add an AI node',
    '从节点右侧圆点拖出连线 · 判断节点有「真/假」两个出口 · 循环节点有「循环体/退出」':
      'Drag from a node\'s right dot to connect · decision nodes have True/False outputs · loop nodes have Loop body/Exit',
    '执行日志': 'Execution Log', '清空画布上的全部节点与连线？': 'Clear all nodes and connections on the canvas?',
    '画布为空，先添加节点': 'Empty canvas; add a node first', '已取消': 'Cancelled',
    '超过最大执行步数': 'Exceeded max steps', '循环体未连线，跳过': 'Loop body not connected, skipping',
    '未知节点类型': 'Unknown node type', '空响应': 'Empty response', '请输出一句确认。': 'Output a confirmation.',
    '你是流程中的一个执行节点，直接输出结果本身，不要寒暄、不要复述任务。':
      'You are an execution node in a flow. Output the result directly; no greetings or restating the task.',

    // 接入中心
    'MODEL & API HUB · 手动接入与故障自愈': 'MODEL & API HUB · manual integration & self-healing',
    '把任意模型和 API': 'Bring any model or API', '接进 NEXUS': 'into NEXUS',
    '填写 API 地址与密钥即可新增一条通道；密钥只保存在本机配置文件，界面永远只显示掩码。通道不可用时点「一键修复」，会自动诊断并修好可回滚的配置问题。':
      'Enter an API URL and key to add a channel; keys stay in a local config file and are always masked. When a channel fails, click "One-Click Repair" to auto-diagnose and fix reversible config issues.',
    '全盘识别': 'Full Disk Scan', '仅体检': 'Dry Run',
    '全盘识别 · 本机磁盘模型': 'Full Disk Scan · Local Disk Models',
    '扫描整个电脑寻找 AI 模型（含非默认盘符、独立 GGUF 文件），只读不改文件':
      'Scans the whole computer for AI models (including non-default drives and standalone GGUF files); read-only',
    '还没扫描。点右上角「全盘识别」扫描本机所有磁盘，找出安装了但运行时没启动的模型。':
      'Not scanned yet. Click "Full Disk Scan" at top right to find installed models that are not running.',
    '新增通道': 'Add Channel', '支持 OpenAI 兼容 / Ollama': 'Supports OpenAI-compatible / Ollama',
    '通道名称': 'Channel Name', '例如：Kimi 国内站': 'e.g. Kimi (China)',
    '接口类型': 'API Type', 'OpenAI 兼容': 'OpenAI-compatible',
    '模型清单路径': 'Model List Path', 'API 地址': 'API URL',
    'OpenAI 兼容服务通常要带 /v1；本地服务可填 http://127.0.0.1:1234/v1':
      'OpenAI-compatible services usually need /v1; local services can use http://127.0.0.1:1234/v1',
    'API Key': 'API Key', '本地服务可留空 · 编辑时留空表示不修改': 'Can be blank for local services · blank when editing keeps existing',
    '默认模型': 'Default Model', '先「测试连接」拉取清单': 'Click "Test Connection" first to fetch models',
    '自动选取第一个模型': 'Auto-select the first model', '测试连接': 'Test Connection',
    '保存通道': 'Save Channel', '取消编辑': 'Cancel Edit', '快速填充': 'Quick Fill',
    'Moonshot 国内站': 'Moonshot (China)', 'Moonshot / Kimi（国内站）': 'Moonshot / Kimi (China)',
    '本机 Ollama': 'Local Ollama', 'dsh 网关': 'dsh Gateway', 'DeepSeek Harness 网关': 'DeepSeek Harness Gateway',
    '已接入通道': 'Connected Channels', '诊断与自愈': 'Diagnostics & Self-Healing',
    '检查自定义通道、dsh 配置、运行时、网关与钱包': 'Checks custom channels, dsh config, runtime, gateways and wallet',
    '修复记录': 'Repair History', '最近 20 次 · 仅保存时间与结果': 'Last 20 · only time and result are saved',
    '尚未运行诊断。点击右上角「一键修复」开始体检并自动修复。': 'No diagnosis yet. Click "One-Click Repair" at top right.',
    '暂无记录': 'No records', '握手正常': 'Handshake OK', '未探测': 'Not probed',
    '已保存': 'Saved', '无（本地服务）': 'None (local service)', '失败': 'Failed', '成功': 'Success',
    '刷新模型': 'Refresh Models', '编辑': 'Edit', '测试通道': 'Test Channel', '删除': 'Delete',
    '自定义接入': 'Custom integration', '密钥': 'Key', '上次握手失败': 'Last handshake failed',
    '正在握手，请稍候…': 'Handshaking, please wait…', '请先填写 API 地址': 'Enter the API URL first',
    '名称和 API 地址不能为空': 'Name and API URL are required', '保存失败': 'Save failed',
    '通道已更新': 'Channel updated', '通道已删除': 'Channel deleted',
    '确定删除通道': 'Delete channel', '？该操作只删除 NEXUS 里的配置，不会影响上游服务。': '? This only removes the NEXUS config; upstream services are unaffected.',
    '本地服务无需密钥': 'No key needed for local services',
    '已填充 Ollama 本机地址，直接点「测试连接」即可。': 'Local Ollama URL filled in; just click "Test Connection".',
    '已填充地址，请填写 API Key 后点「测试连接」。': 'URL filled in; enter the API Key then click "Test Connection".',
    '快速': 'Fast', '中等': 'Medium', '较慢': 'Slow', '体积异常': 'Abnormal size',
    '疑似占位/不完整': 'Suspected placeholder/incomplete',
    '正在全盘扫描本机磁盘，可能需要几秒…': 'Scanning all local disks, may take a few seconds…',
    '本次扫描没有在磁盘上发现可用模型文件。模型通常会放在 Ollama / LM Studio 的默认目录，或 .gguf 文件所在文件夹。':
      'No usable model files found on disk. Models usually live in Ollama / LM Studio default folders or alongside .gguf files.',
    '全盘深度': 'Deep scan', '扫描耗时': 'Scan time',
    '体检通过：没有发现异常，所有通道状态正常。': 'All clear: no issues found, all channels healthy.',
    '仅体检 · 未修改文件': 'Dry run · no files changed', '已自动修复': 'Auto-fixed',
    '需手动处理': 'Needs manual action', '可自动': 'Auto', '人工': 'Manual',
    '高': 'High', '中': 'Medium', '低': 'Low', '优先级': 'priority', '建议：': 'Suggestion: ',
    '配置已修改并备份，需重启 DeepSeek Harness 后生效；dsh 相关改动不会自动重启应用。':
      'Config changed and backed up; restart DeepSeek Harness to apply. dsh changes do not auto-restart the app.',
    '涉及文件：': 'Files: ', '修复': 'Fixed', '待手动': 'Manual pending',
    '正在诊断并自动修复…': 'Diagnosing and auto-repairing…', '正在体检（不会修改任何文件）…': 'Running checks (no files changed)…',

    // 用户优化
    'USER VOICE · 你的想法驱动 NEXUS 进化': 'USER VOICE · your ideas drive NEXUS',
    '用户优化中心': 'User Voice Center',
    '投票选出你最想要的功能，或直接写下对界面样貌与功能的建议。所有内容会汇总发送到产品团队邮箱。':
      'Vote for the features you want most, or write suggestions about looks and features. Everything is sent to the product team.',
    '产品团队邮箱': 'Product team email', '功能投票': 'Feature Voting',
    '点 ▲ 支持、▼ 撤回，按票数实时排序': '▲ upvote, ▼ withdraw; sorted live by votes',
    '加入投票': 'Add Vote', '优化建议': 'Suggestions', '外观样貌 / 功能均可，可留联系方式': 'Looks or features; contact info optional',
    '输入你想要的新功能，例如：支持多窗口并排': 'The feature you want, e.g. side-by-side windows',
    '外观样貌': 'Appearance', '功能': 'Feature', '联系方式（可选，如邮箱/QQ）': 'Contact (optional, email/QQ)',
    '描述你希望优化的地方，越具体越好……': 'Describe what you want improved; be specific…',
    '保存建议': 'Save Suggestion', '把投票与建议发送给团队': 'Send votes & suggestions to the team',
    '未配置发信邮箱时，会自动打开本机邮件客户端并填好内容；配置了 SMTP 则直接发出。':
      'Without SMTP, your local mail client opens with content filled in; with SMTP, it sends directly.',
    '复制内容': 'Copy Content', '发送到邮箱': 'Send by Email',
    '暂无提案，先在下方提交你想到的功能吧。': 'No proposals yet; submit a feature below.',
    '你提交的外观/功能建议会显示在这里。': 'Your appearance/feature suggestions appear here.',
    '用户新增': 'New', '待发送': 'Pending', '已发送': 'Sent',
    '投票已记录': 'Vote recorded', '投票失败：': 'Vote failed: ', '请填写功能名称': 'Enter a feature name',
    '功能提案已加入投票': 'Feature proposal added', '提交失败：': 'Submit failed: ',
    '请填写建议内容': 'Enter suggestion content', '建议已保存，可点「发送到邮箱」提交给团队': 'Suggestion saved; click "Send by Email" to submit',
    '保存失败：': 'Save failed: ', '正在提交…': 'Sending…', '已发送到': 'Sent to',
    '已打开邮件客户端，收件人：': 'Mail client opened, recipient: ', '发送失败：': 'Send failed: ',
    '反馈内容已复制，可手动粘贴到邮件': 'Feedback copied; paste it into an email', '复制失败：': 'Copy failed: ',
    '功能建议': 'Feature', '界面外观': 'Appearance', '体验问题': 'User experience', '错误报告': 'Bug report',
    '提案': 'Proposals', '总票数': 'Total votes', '建议': 'Suggestions', '已发送': 'Sent',
    '支持 +1': 'Support +1', '撤回 -1': 'Withdraw -1', '删除': 'Delete', '标记已发送': 'Mark as sent',
    '确认删除这条建议？': 'Delete this suggestion?', '已删除建议': 'Suggestion deleted',
    '操作失败：': 'Operation failed: ', '你已经支持过这项提案': 'You already supported this proposal',
    '你还没有支持这项提案': 'You have not supported this proposal',

    // 设置
    '启动时自动识别': 'Detect on startup', '每次打开都重新扫描本机 AI，并写回配置': 'Rescan local AI every launch and write back config',
    '扫描超时': 'Scan timeout', '单个端点的握手等待上限，越小越灵敏、越容易误判离线': 'Handshake wait per endpoint; lower is snappier but may misjudge offline',
    '对话路由': 'Chat routing', '自动 = 挑选在线且延迟最低的通道': 'Auto = pick the online channel with lowest latency',
    '固定当前选择': 'Pin current selection', '报错时自动修复': 'Auto-repair on error',
    '对话失败后自动在后台跑一次诊断与可回滚修复，90 秒内不重复触发': 'On failure, run a background diagnosis and reversible repair; no repeat within 90s',
    '免费兜底模型': 'Free fallback model', '零配置时提供免密钥的公共模型（需联网）；关闭后仅使用本机与已添加的通道': 'Keyless public model when unconfigured (needs internet); off = only local and added channels',
    '本地模型速度': 'Local Model Speed', '无独显电脑建议开启': 'Recommended for machines without a dedicated GPU',
    '选模型策略': 'Model selection policy', '自动 = 简单问题用小模型、复杂的才用大模型；最快 = 永远用最小模型': 'Auto = small model for simple questions; Fastest = always the smallest',
    '始终最快': 'Always fastest', '始终高质量': 'Always highest quality', '固定模型': 'Pinned model', '手动指定': 'Manual',
    '固定使用的本地模型': 'Pinned local model', '仅当上面选「固定模型」时生效': 'Only applies when "Pinned model" is selected above',
    '例如 qwen2.5:3b': 'e.g. qwen2.5:3b', '深度思考（默认开启）': 'Deep Thinking (on by default)',
    '像 DeepSeek 一样展示模型的思考过程；纯 CPU 上会更慢，可在输入框随时开关': 'Show reasoning like DeepSeek; slower on CPU-only machines; toggle anytime in the input box',
    '关闭本地思考链': 'Disable local reasoning', '本地模型先生成思维链再回答，纯 CPU 上关闭可提速 4 倍以上（深度思考开启时以深度思考为准）':
      'Local models reason before answering; disabling can be 4x+ faster on CPU (Deep Thinking takes precedence)',
    '上下文窗口': 'Context window', '越小越省内存、越快；长文处理可调大': 'Smaller = less memory and faster; raise for long text',
    '声音控制': 'Sound Control', '只影响当前正在发声的程序': 'Only affects apps currently playing sound',
    '当前声音': 'Current sound', '静音': 'Mute', '恢复': 'Restore',
    '已静音 · 点击「恢复」让当前程序继续发声': 'Muted · click "Restore" to resume sound',
    '正在发声：': 'Playing: ', '当前没有程序在播放声音': 'No app is currently playing sound',
    '播放中': 'Playing', '已静音': 'Muted',
    '开启静音后，会暂停当前正在播放声音的程序（如网页视频/音乐）；再次点击恢复。不修改系统音量，也不影响之后新开启的声音。':
      'Muting pauses apps currently playing sound (e.g. browser video/music); click again to restore. System volume and future sounds are unaffected.',
    '声音控制不可用（需要本机 Python 3 + pycaw）': 'Sound control unavailable (needs local Python 3 + pycaw)',
    '不可用': 'Unavailable', '未知程序': 'Unknown app', 'Edge 浏览器': 'Edge Browser',
    'Chrome 浏览器': 'Chrome Browser', 'Firefox 浏览器': 'Firefox Browser',
    '微信内置播放器': 'WeChat Player', '微信': 'WeChat', '迅雷': 'Xunlei',
    'QQ 音乐': 'QQ Music', '网易云音乐': 'NetEase Cloud Music',
    '已静音': 'Muted', '个发声程序': ' sound sources', '当前没有在播放的声音': 'Nothing is playing now',
    '声音切换失败': 'Sound toggle failed',
    '反馈发信邮箱（可选）': 'Feedback Email (optional)',
    '配置后「用户优化」里的建议可一键直发，不配置则用本机邮件客户端': 'When set, suggestions in User Voice can be sent directly; otherwise the local mail client is used',
    'SMTP 服务器': 'SMTP Server', '例如 smtp.sina.com': 'e.g. smtp.sina.com',
    '端口': 'Port', 'SSL 465 / STARTTLS 587': 'SSL 465 / STARTTLS 587',
    '发件邮箱': 'Sender Email', '用于登录 SMTP 的账号': 'Account used to log in to SMTP',
    '密码 / 授权码': 'Password / App Code', '只保存在本机，不上传': 'Stored locally only, never uploaded',
    '邮箱授权码': 'Email app code', '使用 SSL 直连': 'Use direct SSL', '465 勾选；587 取消勾选走 STARTTLS': 'Check for 465; uncheck for 587 (STARTTLS)',
    '保存发信设置': 'Save Mail Settings', '发信设置已保存到本机': 'Mail settings saved locally',
    '本机数据': 'Local Data', '配置目录': 'Config Directory',
    '密钥策略': 'Key Policy', '不复制、不落盘；对话时按需从原应用凭据位置读取': 'No copy, no disk write; reads from original credential locations on demand',
    '网络出口': 'Network Egress', '仅本机回环 127.0.0.1，不对外开放端口': 'Loopback 127.0.0.1 only; no open external ports',
    '软件更新': 'Software Update', '检查官网新版本，一键下载对应平台的安装包': 'Check the official site for new versions and download the matching package',
    '当前版本': 'Current Version', '点击「检查更新」查看是否有新版本': 'Click "Check for Updates" to see if a new version exists',
    '检查更新': 'Check for Updates', '新版本': 'New Version', '下载并安装': 'Download & Install',
    '打开安装包': 'Open Installer', '取消': 'Cancel', '准备中…': 'Preparing…',
    '正在连接官网检查版本…': 'Connecting to official site…', '暂时无法连接更新服务器': 'Cannot reach the update server',
    '请检查网络后重试；也可以直接到官网下载最新版本。': 'Check your network and retry; or download the latest from the website.',
    '当前平台暂无对应安装包，请到官网手动下载。': 'No package for this platform; download manually from the website.',
    '已是最新版本': 'Already up to date', '检查失败': 'Check failed', '检查更新失败，请稍后重试': 'Check failed; try again later',
    '没有可用的安装包': 'No package available', '下载中…': 'Downloading…', '正在下载安装包…': 'Downloading package…',
    '重试下载': 'Retry Download', '无法开始下载': 'Could not start download',
    '下载完成，已通过 SHA256 校验': 'Download complete, SHA256 verified', '安装包已就绪': 'Installer ready',
    '重新下载': 'Download Again', '已取消下载': 'Download cancelled', '下载失败': 'Download failed',
    '安装包尚未下载完成': 'Installer not fully downloaded', '当前是浏览器预览模式，无法打开本地安装包': 'Browser preview mode cannot open local installers',
    '已打开安装包，请按系统提示完成安装': 'Installer opened; follow the system prompts', '打开失败': 'Failed to open',
    '校验通过。点「打开安装包」后，按系统提示完成安装；安装完成后重启 NEXUS 即为新版本。安装过程不会改动你的数据目录。':
      'Verified. Click "Open Installer" and follow the prompts; restart NEXUS to use the new version. Your data directory is untouched.',
    '关于': 'About', '开发者': 'Developer', '田锦康 · © 2026 NEXUS AI 工作台 · 保留所有权利': 'Tian Jinkang · © 2026 NEXUS AI Workbench · All rights reserved',
    '保留所有权利': 'All rights reserved',
    '已保存': 'Saved',

    // 演示/错误文案
    '免密钥公共模型 · 无需配置即可使用（匿名额度有限）': 'Keyless public model · works with no setup (limited anonymous quota)',
    '免费通用 · gpt-oss-20b': 'Free General · gpt-oss-20b', '免费 Mistral（额度收紧）': 'Free Mistral (tight quota)',
    '免费 Llama': 'Free Llama', 'NEXUS 免费模型': 'NEXUS Free Model',
    '内置模拟通道，用于零依赖演示': 'Built-in mock channel for zero-dependency demo',
    'NEXUS 演示节点': 'NEXUS Demo Node', '未启动': 'Not running',
    '已复用本机凭据 · 12 个模型': 'Reused local credentials · 12 models',
    '通道受限（HTTP 400），可能额度不足': 'Channel restricted (HTTP 400), possibly low quota',
    '配置目录已识别 · 免费模型目录 12 条': 'Config dir detected · 12 free model entries',
    '已挂载 1 个 MCP 服务': '1 MCP service mounted',
    '（演示思维链）先理解问题，再拆解要点，最后组织成一段清楚的回复。真实模型会在这里逐步推理。':
      '(Demo reasoning) Understand the question, break down key points, then write a clear answer. A real model reasons step by step here.',
    '（预览模式）当前页面没有连上本地服务，这是一段内置的模拟回复。': '(Preview mode) Not connected to the local service; this is a built-in mock reply.',
    '你问的是：': 'You asked: ',
    '正式运行请在项目目录执行 npm start（Electron 窗口）或 npm run web（浏览器模式），': 'For real use, run npm start (Electron) or npm run web (browser) in the project directory;',
    'NEXUS 会在启动时自动扫描本机的 Ollama、LM Studio、DeepSeek Harness、Claude Desktop 等对象，': 'NEXUS auto-scans local Ollama, LM Studio, DeepSeek Harness, Claude Desktop and more at startup,',
    '并把可用通道挂到侧边的目标列表里。': 'and lists available channels in the sidebar.',
    '已停止输出': 'Output stopped',
    '预览模式下无法': 'Preview mode cannot ', '，请用 npm start 启动桌面版': '; use npm start for the desktop app',
    '上游钱包余额不足，请到该服务控制台充值，或在侧栏切换到其他通道。': 'Upstream wallet balance is low; top up in that service\'s console or switch channels.',
    '本机保存的密钥失效了，请回到原应用重新登录。': 'The saved key is invalid; sign in again in the original app.',
    '该通道缺少本机运行时依赖，请按提示安装后重试。': 'This channel lacks a local runtime dependency; install it and retry.',
    '触发限流，稍后再试或换通道。': 'Rate limited; retry later or switch channels.',
    '应用 / MCP 节点不支持直接对话，请在画布中作为工具节点使用。': 'App / MCP nodes cannot chat directly; use them as tool nodes on the canvas.',
    '通道已离线，点右上角「重新识别」刷新拓扑。': 'Channel is offline; click "Re-detect" at top right to refresh.',
    '模型或接口路径不存在，可在「模型接入」刷新模型清单，或点「一键修复」。': 'Model or API path not found; refresh models in "Model Hub" or click "One-Click Repair".',
    '缺少 Bun / Python 等本机运行时，点「一键修复」可自动补齐已安装的运行时。': 'Missing a local runtime such as Bun / Python; "One-Click Repair" can add installed runtimes.',
    '对话超出上下文上限，清空会话或换长上下文模型。': 'Context limit exceeded; clear the chat or use a longer-context model.',
    '本地服务已连接': 'Local service connected', '预览模式': 'Preview mode',
    '本地服务 http://127.0.0.1': 'Local service http://127.0.0.1',
    '预览模式：未连接本地服务，回复为内置模拟内容': 'Preview mode: no local service; replies are built-in mock content',
    'v—（预览）': 'v— (preview)', '识别完成：': 'Detection complete: ', '识别失败：': 'Detection failed: ',
    '个在线 / ': ' online / ', '个对象': ' objects',
    '本地模型': 'Local model', '省额度': 'Save quota', '数据留在你的电脑': 'Data stays on your device',
    // 补充：标题 / 语言设置 / 画布工具 / 关于页
    'NEXUS · 本机 AI 编排中枢': 'NEXUS · Local AI Orchestration Hub',
    '本机 AI 编排中枢': 'Local AI Orchestration Hub',
    'MODEL &amp; API HUB · 手动接入与故障自愈': 'MODEL &amp; API HUB · Manual Integration & Self-Healing',
    '界面语言': 'Interface Language', '切换后全界面文字立即生效': 'Applies to the whole interface instantly',
    '显示语言': 'Display Language', '简体中文 / English，切换后自动保存': 'Simplified Chinese / English, saved automatically',
    '自动（推荐）': 'Auto (Recommended)', '说明': 'Notes',
    'Windows 10 / 11 · macOS · Linux · Electron + Node 20+ · AI 群聊 · 深度思考 · 全盘识别 · 用户优化与功能投票 · 系统声音开关 · 免费模型 · 一键自愈':
      'Windows 10 / 11 · macOS · Linux · Electron + Node 20+ · AI Group Chat · Deep Thinking · Full Disk Scan · User Voice & Voting · Sound Control · Free Models · One-Click Repair',
    'AI 群聊 · 多人协作': 'AI Group Chat · Collaboration', '模型接入 · 一键修复': 'Model Hub · One-Click Repair',
    '用户优化 · 功能投票 · 提交建议': 'User Voice · Voting · Feedback',
    '切换语言 / Switch language': 'Switch language / 切换语言',
    '缩小': 'Zoom Out', '放大': 'Zoom In', '适应画布': 'Fit Canvas', '清空画布': 'Clear Canvas',
    // 补充：API 演示动作 / 状态标签 / 更多提示
    '安装插件': 'Install plugin', '切换声音': 'Toggle sound', '投票': 'Vote',
    '提交功能提案': 'Submit feature proposal', '提交建议': 'Submit suggestion',
    '生成邮件': 'Generate email', '发送反馈': 'Send feedback',
    '下载更新': 'Download update', '查询下载进度': 'Check download progress',
    '读取自定义通道': 'Read custom channels', '测试 API 连接': 'Test API connection',
    '保存通道': 'Save channel', '更新通道': 'Update channel', '删除通道': 'Delete channel',
    '刷新模型清单': 'Refresh model list', '复测通道': 'Retest channel',
    '运行诊断修复': 'Run diagnostics & repair', '发起群聊': 'Start group chat',
    '读取插件列表': 'Read plugin list', '检查更新': 'Check for updates',
    '此前发言：': 'Earlier: ', '（无内容）': '(No content)', '无内容': 'No content',
    '还在回复中': 'A reply is still in progress',
    '当前环境不支持语音识别，可直接输入文字': 'Speech recognition not supported here; type instead',
    '语音识别失败': 'Speech recognition failed',
    '用户新增': 'New', '全员回答': 'Everyone answers', '轮流接龙': 'Relay',
    '密钥留空表示沿用已保存的值': 'Leave key blank to keep the saved value',
    '离线': 'Offline', '受限': 'Restricted', '已安装': 'Installed', '已配置': 'Configured',
    '免费': 'Free', '·桥接': ' · Bridged', '桥接': 'Bridged', '未知': 'Unknown',
    '在线模型': 'Online model', '手动': 'Manual', '无': 'None'
  };

  /* -------- 带变量的模式规则（先于精确匹配） -------- */
  const RULES = [
    { re: /^识别完成：(\d+) 个在线 \/ (\d+) 个对象$/, to: m => `Detection complete: ${m[1]} online / ${m[2]} objects` },
    { re: /^(\d+) 个在线 · (\d+) 个对象 · (\d+)ms$/, to: m => `${m[1]} online · ${m[2]} objects · ${m[3]}ms` },
    { re: /^(\d+) 个模型\/通道 · 生成于 (.+)$/, to: m => `${m[1]} models/channels · generated at ${m[2]}` },
    { re: /^(\d+) 项 · 不计入模型总数$/, to: m => `${m[1]} items · not counted as models` },
    { re: /^(\d+) 模型 · (.+)$/, to: m => `${m[1]} models · ${m[2]}` },
    { re: /^(\d+) 个$/, to: m => `${m[1]}` },
    { re: /^下载中 (\d+)% · (.+) \/ (.+) MB$/, to: m => `Downloading ${m[1]}% · ${m[2]} / ${m[3]} MB` },
    { re: /^发现新版本 v(.+) · 当前 v(.+)$/, to: m => `New version v${m[1]} available · current v${m[2]}` },
    { re: /^已是最新版本 v(.+)$/, to: m => `Already up to date v${m[1]}` },
    { re: /^第 (\d+)\/(\d+) 轮$/, to: m => `Round ${m[1]}/${m[2]}` },
    { re: /^(.+) · 群聊进行中…$/, to: m => `${m[1]} · group chat running…` },
    { re: /^(.+) · (\d+) 位成员已就位$/, to: m => `${m[1]} · ${m[2]} members ready` },
    { re: /^已深度思考（用时 (\d+) 秒）$/, to: m => `Deep thinking complete (${m[1]}s)` },
    { re: /^由 (.+) 代答$/, to: m => `Answered by ${m[1]}` },
    { re: /^（(.+) 未能发言：(.+)）$/, to: m => `(${m[1]} could not respond: ${m[2]})` },
    { re: /^任务：(.+)$/, to: m => `Task: ${m[1]}` },
    { re: /^输出：(.+)$/, to: m => `Output: ${m[1]}` },
    { re: /^流程完成，共 (\d+) 步$/, to: m => `Flow completed, ${m[1]} steps` },
    { re: /^流程失败：(.+)$/, to: m => `Flow failed: ${m[1]}` },
    { re: /^(\d+) 条自定义通道$/, to: m => `${m[1]} custom channels` },
    { re: /^上次握手：(.+)（(成功|失败)）$/, to: m => `Last handshake: ${m[1]} (${m[2] === '成功' ? 'OK' : 'Failed'})` },
    { re: /^正在编辑「(.+)」$/, to: m => `Editing "${m[1]}"` },
    { re: /^已自动修复 (\d+) 项，请重新发送$/, to: m => `Auto-fixed ${m[1]} issue(s), please resend` },
    { re: /^诊断发现 (\d+) 项需手动处理$/, to: m => `${m[1]} issue(s) need manual handling` },
    { re: /^全盘识别完成：(\d+) 个本机模型$/, to: m => `Full scan complete: ${m[1]} local models` },
    { re: /^全盘识别失败：(.+)$/, to: m => `Full scan failed: ${m[1]}` },
    { re: /^扫描整个电脑寻找 AI 模型.*$/, to: () => 'Scans the whole computer for AI models; read-only' },
    { re: /^扫描耗时 (\d+)ms · (全盘深度|快速)$/, to: m => `Scan time ${m[1]}ms · ${m[2] === '全盘深度' ? 'deep' : 'quick'}` },
    { re: /^修复 (\d+) 项 · 待手动 (\d+) 项$/, to: m => `${m[1]} fixed · ${m[2]} manual pending` },
    { re: /^耗时 (\d+)ms$/, to: m => `${m[1]}ms` },
    { re: /^(\d+) 个$/, to: m => String(m[1]) },
    { re: /^已静音 (\d+) 个发声程序$/, to: m => `Muted ${m[1]} sound sources` },
    { re: /^已恢复 (\d+) 个程序$/, to: m => `Restored ${m[1]} apps` },
    { re: /^调用失败：(.+)$/, to: m => `Call failed: ${m[1]}` },
    { re: /^(.+)：(.+)$/, to: null } // placeholder, skipped below
  ];
  // 移除占位规则（避免误伤）
  RULES.pop();

  const ATTRS = ['placeholder', 'title', 'aria-label', 'data-tip'];
  const SKIP_SELECTORS = '.msg-bubble, .think-content, .ct-text, .group-msgs, .gm-text, #promptInput, #groupInput, .ins-input, .ins-area, [data-i18n-skip]';

  let lang = (root.localStorage && root.localStorage.getItem(KEY)) || ZH;
  const origText = new WeakMap();
  const origAttr = new WeakMap();

  function translateString(s) {
    if (!s || typeof s !== 'string') return s;
    for (const rule of RULES) {
      const m = s.match(rule.re);
      if (m) return rule.to(m);
    }
    if (Object.prototype.hasOwnProperty.call(DICT, s)) return DICT[s];
    return s;
  }

  function shouldSkip(node) {
    const el = node.nodeType === 3 ? node.parentElement : node;
    if (!el) return false;
    try { return !!el.closest(SKIP_SELECTORS); } catch { return false; }
  }

  function applyText(node) {
    if (!node || node.nodeType !== 3) return;
    const cur = node.nodeValue;
    if (!cur || !cur.trim() || shouldSkip(node)) return;
    const stored = origText.get(node);
    if (lang === EN) {
      const lead = (cur.match(/^\s*/) || [''])[0];
      const trail = (cur.match(/\s*$/) || [''])[0];
      const core = cur.trim();
      const targetCore = translateString(core);
      const target = targetCore !== core ? lead + targetCore + trail : cur;
      if (cur !== target) {
        if (stored === undefined) origText.set(node, cur);
        node.nodeValue = target;
      }
    } else if (stored !== undefined && cur !== stored) {
      node.nodeValue = stored;
    }
  }

  function applyAttrs(el) {
    if (!el || el.nodeType !== 1 || shouldSkip(el)) return;
    let map = origAttr.get(el);
    if (!map) { map = {}; origAttr.set(el, map); }
    for (const attr of ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const cur = el.getAttribute(attr);
      if (cur == null) continue;
      if (lang === EN) {
        const target = translateString(cur);
        if (cur !== target) { if (map[attr] === undefined) map[attr] = cur; el.setAttribute(attr, target); }
      } else if (map[attr] !== undefined && cur !== map[attr]) {
        el.setAttribute(attr, map[attr]);
      }
    }
  }

  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) { applyText(node); return; }
    if (node.nodeType !== 1) return;
    applyAttrs(node);
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
  }

  function applyAll() {
    if (!root.document) return;
    walk(root.document.documentElement);
    const meta = root.document.querySelector('meta[name="description"]');
    if (meta) {
      if (lang === EN) meta.setAttribute('content', 'NEXUS is a free, open-source AI workbench for Windows and macOS: auto-discover and unify all local and cloud AI, with AI group chat, deep thinking, full-disk model detection and one-click repair. Download for Windows, macOS and Linux; zero setup with free models.');
    }
    root.document.documentElement.setAttribute('lang', lang === EN ? 'en' : 'zh-CN');
    const title = root.document.getElementById('langBtnLabel');
    if (title) title.textContent = lang === EN ? '中文' : 'EN';
    const sel = root.document.getElementById('setLanguage');
    if (sel) sel.value = lang;
  }

  function setLang(next, persist) {
    lang = next === EN ? EN : ZH;
    try { if (root.localStorage) root.localStorage.setItem(KEY, lang); } catch { /* ignore */ }
    applyAll();
    if (persist !== false && root.NexusAPI && root.NexusAPI.saveSettings) {
      try { root.NexusAPI.saveSettings({ language: lang }); } catch { /* ignore */ }
    }
    root.dispatchEvent && root.dispatchEvent(new CustomEvent('nexus:lang', { detail: { lang } }));
  }

  function init() {
    if (!root.document) return;
    applyAll();
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          r.addedNodes.forEach(walk);
        } else if (r.type === 'characterData') {
          applyText(r.target);
        } else if (r.type === 'attributes' && ATTRS.indexOf(r.attributeName) >= 0) {
          applyAttrs(r.target);
        }
      }
    });
    obs.observe(root.document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
  }

  const api = {
    t: translateString,
    getLang: () => lang,
    setLang,
    init,
    DICT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NexusI18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
