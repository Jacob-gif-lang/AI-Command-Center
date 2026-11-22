'use strict';
/**
 * 配置与状态持久化
 * 落盘位置：%APPDATA%\Nexus\  （Electron 与纯 Node 模式共用同一份）
 * 只存配置与流程，不存任何 API Key —— 密钥一律在使用时从本机原有位置读取。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Nexus');

function ensureDir(dir = ROOT) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

function readJson(name, fallback) {
  try {
    const raw = fs.readFileSync(path.join(ROOT, name), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  ensureDir();
  const target = path.join(ROOT, name);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

const DEFAULT_SETTINGS = {
  version: 1,
  language: 'zh',              // 界面语言：zh 简体中文 / en 英文
  autoDetectOnStart: true,
  scanTimeoutMs: 1600,
  extraEndpoints: [],          // [{ id, name, base, apiKeyEnv, kind }]
  routing: 'auto',             // auto | pinned
  pinnedProviderId: null,
  theme: 'midnight',
  speakOnCall: true,
  maxFlowSteps: 200,
  autoRepairOnError: true,     // 通道报错时自动尝试自愈
  freeFallback: true,          // 零配置时注入免密钥免费通道
  /* 本地模型智能选择：
   *   auto      —— 按问题复杂度自动选（简单问题走小模型，复杂的才用大模型）
   *   fastest   —— 永远选最小最快的模型
   *   quality   —— 永远选最大的模型
   *   pinned:<id> —— 固定用某个模型（用户在设置页指定） */
  localModelPolicy: 'auto',
  pinnedLocalModel: null,
  ollamaThink: false,          // 本地模型思考链总开关（纯 CPU 提速 4 倍以上）
  deepThink: false,            // 输入框「深度思考」开关：开启后本次请求强制显示思维链（像 DeepSeek）
  ollamaNumCtx: 4096,          // 上下文窗口上限，避免吃满内存
  updateFeedUrl: '',           // 更新清单地址，留空用官方默认（HTTPS）
  autoCheckUpdate: true        // 启动时后台静默检查一次新版本
};

function getSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, readJson('settings.json', {}));
}

function saveSettings(patch) {
  const next = Object.assign({}, getSettings(), patch || {});
  writeJson('settings.json', next);
  return next;
}

function getFlows() {
  return readJson('flows.json', { activeId: 'default', flows: [] });
}

function saveFlows(payload) {
  writeJson('flows.json', payload);
  return payload;
}

/** 探测结果缓存（不跨进程持久化也可以，这里存一份便于冷启动秒开） */
function getSnapshot() {
  return readJson('snapshot.json', null);
}

function saveSnapshot(snapshot) {
  try { writeJson('snapshot.json', snapshot); } catch { /* ignore */ }
  return snapshot;
}

/* ------------------------------------------------- 自定义接入（用户手填 API） */

/**
 * 自定义通道清单。
 * 与自动探测的通道不同：这些是用户手动填写的 API 地址 + 密钥 + 模型。
 * 密钥明文只落在本机这一个文件里，返回给渲染层时一律掩码。
 */
function getCustomProviders() {
  const data = readJson('custom-providers.json', { version: 1, providers: [] });
  const list = Array.isArray(data.providers) ? data.providers : [];
  return list;
}

function saveCustomProviders(list) {
  const payload = { version: 1, providers: Array.isArray(list) ? list : [] };
  writeJson('custom-providers.json', payload);
  return payload.providers;
}

/** 对外输出用的掩码视图（不含明文密钥） */
function publicCustomProvider(p) {
  const key = p.apiKey || '';
  return {
    id: p.id,
    name: p.name,
    kind: p.kind || 'openai',
    baseUrl: p.baseUrl,
    listPath: p.listPath || '/models',
    hasKey: !!key,
    keyHint: key ? `${String(key).slice(0, 4)}****${String(key).slice(-3)}` : null,
    models: Array.isArray(p.models) ? p.models : [],
    modelId: p.modelId || (p.models && p.models[0] && p.models[0].id) || null,
    lastProbe: p.lastProbe ? {
      at: p.lastProbe.at,
      ok: !!p.lastProbe.ok,
      status: p.lastProbe.status || 0,
      latencyMs: p.lastProbe.latencyMs || 0,
      message: p.lastProbe.message || ''
    } : null,
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null
  };
}

/* ------------------------------------------------------------- 修复记录 */

function getRepairLog() {
  const data = readJson('repair-log.json', { entries: [] });
  return Array.isArray(data.entries) ? data.entries : [];
}

function appendRepairLog(entry) {
  const entries = getRepairLog();
  entries.unshift(entry);
  while (entries.length > 20) entries.pop();
  try { writeJson('repair-log.json', { entries }); } catch { /* ignore */ }
  return entry;
}

module.exports = {
  ROOT,
  ensureDir,
  readJson,
  writeJson,
  getSettings,
  saveSettings,
  getFlows,
  saveFlows,
  getSnapshot,
  saveSnapshot,
  getCustomProviders,
  saveCustomProviders,
  publicCustomProvider,
  getRepairLog,
  appendRepairLog
};
