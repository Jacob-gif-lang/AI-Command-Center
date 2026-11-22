'use strict';
/**
 * 本机 AI 探测层（Discovery Layer）
 * ------------------------------------------------------------
 * 职责：发现 → 握手 → 归一化。不负责推理调用（见 providers.js）。
 *
 * 探测维度：
 *   1. HTTP 端点扫描   —— Ollama / LM Studio / llama.cpp / vLLM / Jan / GPT4All 等
 *   2. 已装应用识别     —— DeepSeek Harness、Claude Desktop（含 MCP 配置）
 *   3. MCP 服务清单     —— 读取 WorkBuddy / Claude 的 mcp.json
 *   4. 凭据复用         —— 从本机已装 AI 应用的凭据文件中提取通道（不落盘、不外传）
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { probe, pickModels } = require('./probe');
const custom = require('./custom');
const store = require('./store');
const free = require('./free');
const diskScan = require('./disk-scan');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const TIMEOUT = 1600;

/* ------------------------------------------------------------------ utils */

function exists(p) {
  if (!p) return false;
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readJson(p, fallback = null) {
  const t = readText(p);
  if (!t) return fallback;
  try { return JSON.parse(t); } catch { return fallback; }
}

function firstExisting(list) {
  for (const p of list) if (exists(p)) return p;
  return null;
}

/** 在任意层级的 YAML 文本里按名字找标量值（本机凭据文件是嵌套 records 结构，不做完整解析） */
function findCredential(text, names) {
  if (!text) return null;
  for (const name of names) {
    const re = new RegExp(`^\\s*${name}\\s*:\\s*(['"]?)([^\\s'"]+)\\1\\s*$`, 'm');
    const m = re.exec(text);
    if (m && m[2]) return { name, value: m[2] };
  }
  return null;
}

/* --------------------------------------------------------- HTTP 端点定义 */

const HTTP_TARGETS = [
  {
    id: 'ollama', name: 'Ollama', vendor: 'Ollama', kind: 'ollama',
    base: 'http://127.0.0.1:11434', listPath: '/api/tags',
    caps: ['chat', 'embedding', 'local'], note: '本地 GGUF 推理引擎'
  },
  {
    id: 'lmstudio', name: 'LM Studio', vendor: 'LM Studio', kind: 'openai',
    base: 'http://127.0.0.1:1234', listPath: '/v1/models',
    caps: ['chat', 'openai-api', 'local'], note: '本地模型运行时'
  },
  {
    id: 'jan', name: 'Jan', vendor: 'Jan', kind: 'openai',
    base: 'http://127.0.0.1:1337', listPath: '/v1/models',
    caps: ['chat', 'openai-api', 'local'], note: '开源本地客户端'
  },
  {
    id: 'llamacpp', name: 'llama.cpp server', vendor: 'ggerganov', kind: 'openai',
    base: 'http://127.0.0.1:8080', listPath: '/v1/models',
    caps: ['chat', 'openai-api', 'local'], note: 'llama-server 直连'
  },
  {
    id: 'vllm', name: 'vLLM', vendor: 'vLLM', kind: 'openai',
    base: 'http://127.0.0.1:8000', listPath: '/v1/models',
    caps: ['chat', 'openai-api', 'local'], note: '高吞吐推理服务'
  },
  {
    id: 'koboldcpp', name: 'KoboldCpp', vendor: 'KoboldAI', kind: 'openai',
    base: 'http://127.0.0.1:5001', listPath: '/api/v1/model',
    caps: ['chat', 'local'], note: 'KoboldCpp 单文件服务'
  },
  {
    id: 'gpt4all', name: 'GPT4All', vendor: 'Nomic', kind: 'openai',
    base: 'http://127.0.0.1:4891', listPath: '/v1/models',
    caps: ['chat', 'local'], note: 'GPT4All 本地服务'
  },
  {
    id: 'dsh', name: 'DeepSeek Harness', vendor: 'DeepSeek', kind: 'openai',
    base: 'http://127.0.0.1:8326', listPath: '/v1/models',
    caps: ['chat', 'gateway', 'models'], note: '本机 AI 工作台网关',
    authFrom: () => readText(path.join(HOME, '.dsh', 'openai-gateway', 'api-key'))
  }
];

/* ------------------------------------------------------- 本机凭据 → 通道 */

const CREDENTIAL_CHANNELS = [
  {
    keyNames: ['MOONSHOTAI_API_KEY', 'MOONSHOT_API_KEY'],
    id: 'moonshot', name: 'Moonshot / Kimi', vendor: 'Moonshot AI',
    base: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2.6', 'kimi-k2-turbo-preview', 'moonshot-v1-32k'],
    caps: ['chat', 'long-context']
  },
  {
    keyNames: ['DEEPSEEK_API_KEY'],
    id: 'deepseek', name: 'DeepSeek 开放平台', vendor: 'DeepSeek',
    base: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    caps: ['chat', 'reasoning']
  },
  {
    keyNames: ['TEAMO_API_KEY'],
    id: 'teamo', name: 'TeamoRouter', vendor: 'Teamo',
    base: 'https://api.teamorouter.com/v1',
    models: ['deepseek-v4-pro-260425', 'claude-sonnet-4.5', 'gpt-5.1'],
    caps: ['chat', 'aggregator']
  },
  {
    keyNames: ['OPENROUTER_API_KEY'],
    id: 'openrouter', name: 'OpenRouter', vendor: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5.1'],
    caps: ['chat', 'aggregator']
  }
];

/* ------------------------------------------------------------ 探测主流程 */

async function detectHttpTarget(target, timeout) {
  const headers = {};
  const apiKey = target.authFrom ? (target.authFrom() || '').trim() : '';
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await probe(target.base + target.listPath, { headers, timeout: timeout || TIMEOUT });
  const base = {
    id: target.id,
    name: target.name,
    vendor: target.vendor,
    kind: target.kind,
    endpoint: target.base,
    caps: target.caps,
    note: target.note,
    source: 'endpoint-scan',
    requiresKey: !!apiKey,
    chatCapable: target.kind === 'openai' || target.kind === 'ollama'
  };

  if (!res.ok) {
    return Object.assign(base, {
      status: 'offline',
      latencyMs: res.latency,
      models: [],
      detail: res.status ? `HTTP ${res.status}` : (res.error || 'unreachable')
    });
  }

  let models = pickModels(res.json);
  if (target.kind === 'ollama') {
    models = (res.json && res.json.models ? res.json.models : []).map((m) => {
      const id = m.name || m.model;
      const bytes = Number(m.size) || 0;
      const gb = bytes / (1024 * 1024 * 1024);
      // 速度分级：纯 CPU 推理下，模型体积直接决定 token/s。
      //   fast   ≤3GB   约 15-40 tok/s
      //   medium ≤9GB   约 5-12 tok/s
      //   slow   >9GB   内存可能不够，1-4 tok/s
      const speedTier = gb <= 3.5 ? 'fast' : (gb <= 9 ? 'medium' : 'slow');
      return {
        id, name: id,
        sizeBytes: bytes,
        sizeGB: Math.round(gb * 10) / 10,
        speedTier,
        // thinking 系列默认射频耗大户，标注出来供路由参考
        thinking: /qwen3|deepseek-r1|reasoner|think/i.test(id)
      };
    });
  }
  return Object.assign(base, {
    status: 'online',
    latencyMs: res.latency,
    models,
    modelCount: models.length,
    detail: models.length ? `${models.length} 个模型可用` : '服务在线'
  });
}

function detectApps() {
  const apps = [];

  /* DeepSeek Harness */
  const dshHome = path.join(HOME, '.dsh');
  if (exists(dshHome)) {
    const settings = readJson(path.join(dshHome, 'our-free-model', 'settings.json'), {});
    const catalog = readJson(path.join(dshHome, 'our-free-model', 'catalog.json'), {});
    const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
    apps.push({
      id: 'dsh-app',
      name: 'DeepSeek Harness',
      vendor: 'DeepSeek',
      kind: 'app',
      endpoint: dshHome,
      status: 'installed',
      caps: ['host', 'mcp', 'multi-model'],
      source: 'app-scan',
      detail: `配置目录 ${dshHome} · 免费模型目录 ${entries.length} 条`,
      models: entries.slice(0, 12).map((e) => ({ id: String(e.id || e.model || ''), name: String(e.label || e.id || '') })).filter((m) => m.id),
      meta: {
        freeLane: settings.freeLane || null,
        enabled: settings.enabled !== false
      },
      chatCapable: false
    });
  }

  /* Claude Desktop */
  const claudeDataDir = path.join(LOCALAPPDATA, 'Claude-Data', 'claude_pzs8sxrjxfjjc');
  const claudeCfgPath = firstExisting([
    path.join(claudeDataDir, 'claude_desktop_config.json'),
    path.join(APPDATA, 'Claude', 'claude_desktop_config.json')
  ]);
  if (exists(claudeDataDir) || exists(path.join(APPDATA, 'Claude')) || claudeCfgPath) {
    const cfg = claudeCfgPath ? readJson(claudeCfgPath, {}) : {};
    const servers = Object.keys(cfg.mcpServers || {});
    apps.push({
      id: 'claude-desktop',
      name: 'Claude Desktop',
      vendor: 'Anthropic',
      kind: 'app',
      endpoint: claudeCfgPath || claudeDataDir,
      status: 'installed',
      caps: ['host', 'mcp'],
      source: 'app-scan',
      detail: servers.length ? `已挂载 ${servers.length} 个 MCP 服务` : '已安装，暂无 MCP 服务',
      models: [],
      meta: { mcpServers: servers, configPath: claudeCfgPath },
      chatCapable: false
    });
  }

  /* WorkBuddy（本机 AI 编排助手 / 当前这款应用的宿主环境） */
  const workbuddyHome = path.join(HOME, '.workbuddy');
  if (exists(workbuddyHome)) {
    const wbCfg = readJson(path.join(workbuddyHome, 'mcp.json'), {});
    const wbServers = Object.keys(wbCfg.mcpServers || {});
    const connectorsDir = path.join(workbuddyHome, 'connectors');
    let connectorCount = 0;
    try { connectorCount = fs.readdirSync(connectorsDir).filter((n) => !n.startsWith('.')).length; } catch { /* ignore */ }
    apps.push({
      id: 'workbuddy',
      name: 'WorkBuddy',
      vendor: 'Tencent',
      kind: 'app',
      endpoint: workbuddyHome,
      status: 'installed',
      caps: ['host', 'mcp', 'connectors', 'agent'],
      source: 'app-scan',
      detail: `本机 AI 助手 · ${wbServers.length} 个 MCP 服务 · ${connectorCount} 个连接器`,
      models: [],
      meta: {
        mcpServers: wbServers,
        connectors: connectorCount,
        configPath: path.join(workbuddyHome, 'mcp.json')
      },
      chatCapable: false,
      isBridge: true
    });
  }

  return apps;
}

function detectMcpServers() {
  const found = [];
  const sources = [
    { file: path.join(HOME, '.workbuddy', 'mcp.json'), owner: 'WorkBuddy' },
    { file: path.join(LOCALAPPDATA, 'Claude-Data', 'claude_pzs8sxrjxfjjc', 'claude_desktop_config.json'), owner: 'Claude Desktop' },
    { file: path.join(APPDATA, 'Claude', 'claude_desktop_config.json'), owner: 'Claude Desktop' },
    { file: path.join(HOME, '.cursor', 'mcp.json'), owner: 'Cursor' }
  ];
  for (const src of sources) {
    const cfg = readJson(src.file, null);
    if (!cfg || !cfg.mcpServers) continue;
    for (const [name, def] of Object.entries(cfg.mcpServers)) {
      const cmd = def.command || def.url || '';
      const resolved = cmd && path.isAbsolute(cmd) ? cmd : cmd;
      found.push({
        id: `mcp:${src.owner}:${name}`,
        name,
        vendor: src.owner,
        kind: 'mcp',
        endpoint: cmd,
        status: exists(path.isAbsolute(cmd) ? cmd : '') || def.url ? 'configured' : 'configured',
        caps: ['tools', 'stdio'],
        source: 'mcp-config',
        detail: `${src.owner} · ${Array.isArray(def.args) ? def.args.join(' ') : ''}`.trim(),
        models: [],
        chatCapable: false,
        meta: { configPath: src.file, command: def.command, args: def.args || [], available: path.isAbsolute(cmd) ? exists(cmd) : true }
      });
    }
  }
  return found;
}

async function detectCloudChannels() {
  const credPath = firstExisting([
    path.join(HOME, '.dsh', '.credentials.yaml'),
    path.join(HOME, '.nexus', 'credentials.yaml')
  ]);
  if (!credPath) return [];
  const credText = readText(credPath);

  const tasks = CREDENTIAL_CHANNELS.map(async (ch) => {
    const hit = findCredential(credText, ch.keyNames);
    if (!hit) return null;
    const apiKey = hit.value;
    const res = await probe(ch.base + '/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 2200
    });
    const models = pickModels(res.json);
    const online = res.ok;
    return {
      id: `cloud:${ch.id}`,
      name: ch.name,
      vendor: ch.vendor,
      kind: 'openai',
      endpoint: ch.base,
      status: online ? 'online' : (res.status ? 'restricted' : 'offline'),
      caps: ch.caps,
      source: 'credential-reuse',
      credentialRef: `${path.basename(credPath)}#${hit.name}`,
      detail: online
        ? `已复用本机凭据 · ${models.length} 个模型`
        : res.status === 400 || res.status === 403 || res.status === 402
          ? `通道受限（HTTP ${res.status}），可能额度不足`
          : `不可用（${res.status || res.error}）`,
      models: models.length ? models.slice(0, 60) : ch.models.map((m) => ({ id: m, name: m })),
      modelCount: models.length || ch.models.length,
      chatCapable: true
    };
  });

  const results = await Promise.all(tasks);
  return results.filter(Boolean);
}

/** 探测用户手动添加的自定义接入通道（每次 detect 都重新握手，保证状态新鲜） */
async function detectCustomProviders() {
  const records = custom.rawList();
  if (!records.length) return [];
  const results = await Promise.all(records.map(async (rec) => {
    const probeResult = await custom.handshake(rec);
    return custom.toProvider(rec, probeResult);
  }));
  return results;
}

/**
 * 给每个对象打语义分类，避免把「工具 / 宿主应用」当成模型展示。
 *   model —— 真正能承载推理的模型通道/模型文件
 *   tool  —— MCP 工具服务（给 AI 调用外部能力，本身不是模型）
 *   app   —— 宿主应用 / 网关（容器，不是模型）
 */
function classify(p) {
  if (p.kind === 'mcp') { p.category = 'tool'; p.isTool = true; return p; }
  if (p.kind === 'app') { p.category = 'app'; p.isTool = true; return p; }
  p.category = 'model';
  return p;
}

async function detect(options = {}) {
  const timeout = options.timeout || TIMEOUT;
  const deep = !!options.deep; // 全盘识别：由「模型接入」页显式触发
  const t0 = Date.now();

  const [httpResults, cloudResults, customResults] = await Promise.all([
    Promise.all(HTTP_TARGETS.map((t) => detectHttpTarget(Object.assign({}, t, { timeout })))),
    detectCloudChannels(),
    detectCustomProviders()
  ]);

  const apps = detectApps();
  const mcp = detectMcpServers();

  // 磁盘扫描：默认做快速扫描（高概率目录），全盘识别时做深度扫描。
  // 合并策略：同名模型以在线 HTTP 结果为准（信息更新鲜），磁盘结果填补离线缺口。
  let disk;
  try { disk = diskScan.scan({ deep }); } catch { disk = { providers: [], findings: [] }; }
  const diskProviders = (disk.providers || []).map((p) => {
    const live = httpResults.find((h) => h.id === 'ollama' && h.status === 'online');
    if (p.id === 'disk:ollama' && live) {
      // Ollama 已启动：HTTP /api/tags 已给出权威清单，磁盘条目仅补充体积/参数信息
      return Object.assign({}, p, {
        detail: `磁盘 ${p.modelCount} 个 · 在线清单 ${live.modelCount || 0} 个`,
        note: 'Ollama 服务在线，可直接在侧栏选择型号对话。'
      });
    }
    return p;
  });

  const all = [
    ...httpResults, ...cloudResults, ...customResults,
    ...diskProviders, ...apps, ...mcp
  ].map(classify);

  // 零配置兜底：始终注入免密钥免费通道，保证任何情况下都有可用模型
  const injected = free.inject(all, store.getSettings()).map(classify);
  const providers = injected.sort((a, b) => {
    const rank = (p) => (p.category === 'tool' || p.category === 'app') ? 5
      : (p.chatCapable && p.status === 'online') ? 0
        : p.status === 'online' ? 1
          : p.source === 'disk-scan' ? 2
            : 3;
    return rank(a) - rank(b);
  });

  // 工具/宿主应用与模型分列：前端据此渲染「工具服务」区，不再混进模型列表
  const tools = providers.filter((p) => p.category === 'tool' || p.category === 'app');
  const modelProviders = providers.filter((p) => p.category === 'model');

  return {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    providers,
    tools,
    diskScan: {
      deep,
      elapsedMs: disk.elapsedMs || 0,
      findings: disk.findings || [],
      roots: disk.roots || {},
      scannedAt: disk.scannedAt || null
    },
    freeFallback: !!(store.getSettings().freeFallback !== false),
    summary: {
      total: providers.length,
      online: providers.filter((p) => p.status === 'online').length,
      chatReady: providers.filter((p) => free.canSpeak(p)).length,
      apps: apps.length,
      mcp: mcp.length,
      tools: tools.length,
      custom: customResults.length,
      // 模型总数只统计真正的模型通道/文件，MCP 与宿主应用不再计入
      models: modelProviders.reduce((n, p) => n + (p.modelCount || (p.models ? p.models.length : 0)), 0),
      diskModels: diskProviders.reduce((n, p) => n + (p.modelCount || (p.models ? p.models.length : 0)), 0)
    }
  };
}

module.exports = { detect, probe, HOME, APPDATA, LOCALAPPDATA };
