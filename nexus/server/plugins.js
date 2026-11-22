'use strict';
/**
 * MCP 插件自动安装引擎（Plugin Installer）
 * ------------------------------------------------------------
 * 用户在对话里说一句「下载/安装 XX 插件」，系统：
 *   1. 识别意图并从内置白名单目录匹配插件；
 *   2. 把启动配置写进 ~/.workbuddy/mcp.json（写前备份）；
 *   3. 后台用 npm 预热下载，首次被宿主拉起时即可用；
 *   4. 回报结果，并提示重新识别挂载。
 *
 * 安全：只接受白名单里的插件，绝不执行用户提供的任意命令。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exec } = require('node:child_process');

const HOME = os.homedir();
const store = require('./store');
const WB_MCP = path.join(HOME, '.workbuddy', 'mcp.json');

/* 白名单插件目录：id / 别名 / npm 包 / 默认启动参数 / 说明 */
const CATALOG = [
  { id: 'filesystem',   aliases: ['文件系统', 'filesystem', 'file system'], pkg: '@modelcontextprotocol/server-filesystem', args: [], needsPath: true, desc: '读写本地文件与目录（可指定允许的目录）' },
  { id: 'git',          aliases: ['git', 'github git', '版本控制'], pkg: '@modelcontextprotocol/server-git', args: [], desc: '读取与操作 Git 仓库' },
  { id: 'github',       aliases: ['github', 'github 插件'], pkg: '@modelcontextprotocol/server-github', args: [], needsEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'], desc: 'GitHub 仓库 / Issue / PR 操作（需 Token）' },
  { id: 'fetch',        aliases: ['fetch', '网页抓取', '网络请求', 'http'], pkg: '@modelcontextprotocol/server-fetch', args: [], desc: '抓取网页与 HTTP 请求' },
  { id: 'sqlite',       aliases: ['sqlite', '数据库', 'sql'], pkg: '@modelcontextprotocol/server-sqlite', args: [], needsPath: true, desc: '查询与操作 SQLite 数据库' },
  { id: 'memory',       aliases: ['memory', '记忆', '知识图谱'], pkg: '@modelcontextprotocol/server-memory', args: [], desc: '持久化记忆与知识图谱' },
  { id: 'sequential-thinking', aliases: ['sequential thinking', '顺序思考', '推理', '思维链', 'thinking'], pkg: '@modelcontextprotocol/server-sequential-thinking', args: [], desc: '结构化分步推理' },
  { id: 'time',         aliases: ['time', '时间', '时区'], pkg: '@modelcontextprotocol/server-time', args: [], desc: '时间与时区查询（需联网）' },
  { id: 'everything',   aliases: ['everything', '全能', '测试插件'], pkg: '@modelcontextprotocol/server-everything', args: [], desc: '官方全功能示例服务' },
  { id: 'puppeteer',    aliases: ['puppeteer', '浏览器', 'browser', 'playwright'], pkg: '@modelcontextprotocol/server-puppeteer', args: [], desc: '浏览器自动化与网页交互' },
  { id: 'windows-mcp',  aliases: ['windows mcp', 'windows-mcp', '电脑控制', '操作电脑'], pkg: null, preinstalled: true, desc: '操作 Windows 桌面与窗口（已安装）' }
];

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
function backup(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const b = p + '.bak-' + Date.now();
    fs.copyFileSync(p, b);
    return b;
  } catch { return null; }
}

/** 从用户一句话里识别要安装的插件 */
function detectIntent(text) {
  const s = String(text || '').toLowerCase();
  const wantInstall = /(下载|安装|添加|装一个|装个|启用|接入|配置|install|add|setup).{0,40}(插件|mcp|server|服务)|(插件|mcp|server).{0,12}(下载|安装|添加|install|add)/i.test(s);
  if (!wantInstall) return null;
  // 先按 alias 匹配（长的优先）
  const hits = [];
  for (const p of CATALOG) {
    for (const a of p.aliases) {
      if (s.includes(String(a).toLowerCase())) hits.push({ p, len: String(a).length });
    }
  }
  hits.sort((a, b) => b.len - a.len);
  return hits.length ? hits[0].p : null;
}

/** 已安装状态：读取 workbuddy 的 mcp.json，对照目录 */
function list() {
  const cfg = readJson(WB_MCP, {});
  const servers = cfg.mcpServers || {};
  return CATALOG.map((p) => {
    const installed = !!servers[p.id];
    return {
      id: p.id, name: p.id, desc: p.desc,
      aliases: p.aliases, pkg: p.pkg,
      installed,
      preinstalled: !!p.preinstalled,
      needsEnv: p.needsEnv || [],
      config: installed ? servers[p.id] : null
    };
  });
}

function installedIds() {
  const cfg = readJson(WB_MCP, {});
  return Object.keys(cfg.mcpServers || {});
}

/** 后台预热下载（不阻塞返回）；成功/失败写入日志 */
function warmup(plugin) {
  if (!plugin.pkg) return;
  const log = (msg) => {
    try {
      const f = path.join(store.ROOT, 'plugins-log.json');
      const data = readJson(f, { entries: [] });
      data.entries.unshift({ at: new Date().toISOString(), plugin: plugin.id, msg });
      data.entries = data.entries.slice(0, 50);
      writeJson(f, data);
    } catch { /* ignore */ }
  };
  log('开始后台下载 ' + plugin.pkg);
  // 用 npx -y 方式拉起，宿主首次调用时会自动下载；这里主动预热一次
  const cmd = `npx -y ${plugin.pkg} --help`;
  exec(cmd, { cwd: HOME, timeout: 120000, windowsHide: true, env: Object.assign({}, process.env, { NO_UPDATE_NOTIFIER: '1' }) }, (err) => {
    log(err ? `预热未完成（首次调用仍会自动下载）：${String(err.message).slice(0, 160)}` : '预热完成');
  });
}

/**
 * 安装插件：由 id 或直接由一句自然语言触发。
 * 返回 { ok, action, plugin, message, needRescan }
 */
function install(input) {
  let plugin = null;
  if (typeof input === 'string') {
    plugin = detectIntent(input);
  } else if (input && input.id) {
    plugin = CATALOG.find((p) => p.id === input.id || p.aliases.includes(input.id)) || null;
  }
  if (!plugin) {
    return { ok: false, action: 'unmatched', message: '没认出要装哪个插件。可以说「安装 filesystem 插件」或「装一个浏览器插件」。' };
  }
  if (plugin.preinstalled) {
    return { ok: true, action: 'already', plugin: plugin.id, message: `「${plugin.id}」已经安装好了，无需重复安装。`, needRescan: false };
  }
  const cfg = readJson(WB_MCP, { mcpServers: {} });
  if (!cfg.mcpServers) cfg.mcpServers = {};
  if (cfg.mcpServers[plugin.id]) {
    return { ok: true, action: 'already', plugin: plugin.id, message: `「${plugin.id}」已经在 WorkBuddy 的插件列表里了。`, needRescan: false };
  }

  const def = { command: 'npx', args: ['-y', plugin.pkg].concat(plugin.args || []) };
  const bak = backup(WB_MCP);
  cfg.mcpServers[plugin.id] = def;
  try {
    writeJson(WB_MCP, cfg);
  } catch (err) {
    return { ok: false, action: 'write_failed', plugin: plugin.id, message: `写入配置失败：${err.message}` };
  }
  warmup(plugin);

  const envNote = plugin.needsEnv && plugin.needsEnv.length
    ? `。使用前请在系统环境变量里设置 ${plugin.needsEnv.join(' / ')}`
    : '';
  return {
    ok: true,
    action: 'installed',
    plugin: plugin.id,
    backup: bak,
    message: `已安装「${plugin.id}」插件（${plugin.desc}），配置已写入 WorkBuddy${envNote}。首次使用时会自动下载依赖，稍后点「重新识别」即可在 AI 列表里看到它。`,
    needRescan: true
  };
}

function history() {
  return readJson(path.join(store.ROOT, 'plugins-log.json'), { entries: [] }).entries || [];
}

module.exports = { CATALOG, detectIntent, install, list, installedIds, history, WB_MCP };
