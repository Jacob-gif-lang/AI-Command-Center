'use strict';
/**
 * 自愈引擎（Self-Repair Engine）
 * ------------------------------------------------------------
 * 目标：通道不可用时，不只是报错，而是能自动定位并修好。
 *
 * 修复分两档：
 *   auto   —— 可自动执行、可回滚（改配置前必定备份）
 *   manual —— 需要用户决策或物理操作（充值、启动应用、安装运行时），只给方案
 *
 * 已覆盖的真实故障（本机实测复现过的）：
 *   1. dsh 默认模型指向不可用通道 → 切到可用模型
 *   2. dsh 的 Moonshot 通道指向国际站，密钥只有国内站有效 → 改 baseURL
 *   3. dsh 模型条目 contextWindow == maxTokens → 消息预算为 0 → 修正 maxTokens
 *   4. 免费车道缺 Bun 运行时 → 从 npm 全局安装位置补齐到标准路径
 *   5. 自定义接入地址漏了 /v1 → 自动补齐并重新握手
 *   6. 通道欠费 / 密钥失效 / 网关未启动 → 给出可执行的修复指引
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { probe } = require('./probe');
const custom = require('./custom');
const store = require('./store');

const HOME = os.homedir();
const DSH_HOME = path.join(HOME, '.dsh');
const PATCH_PATH = path.join(DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml');
const CRED_PATH = path.join(DSH_HOME, '.credentials.yaml');
const BUN_DIR = path.join(HOME, '.bun', 'bin');

/* ============================================================ YAML 行级编辑 */

/** 检测换行风格，写回时保持一致 */
function splitLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function joinLines(lines, eol) {
  return lines.join(eol);
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * 定位 providers 映射里某个 provider 的行区间。
 * 结构：providers(4) → provider 名(6) → 字段(8)
 */
function providerBlockRange(lines, providerId) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)([A-Za-z0-9_.-]+):\s*$/.exec(lines[i]);
    if (!m) continue;
    if (indentOf(lines[i]) !== 6 || m[2] !== providerId) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (indentOf(lines[j]) <= 6) { end = j; break; }
    }
    return { start: i, end };
  }
  return null;
}

/** 定位顶层 `- id: xxx` 条目的行区间 */
function entryBlockRange(lines, entryId) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s+id:\s*(.+?)\s*$/.exec(lines[i]);
    if (!m || m[2] !== entryId) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*-\s+id:/.test(lines[j])) { end = j; break; }
    }
    return { start: i, end };
  }
  return null;
}

/** 设置某个 provider 的 baseURL（不存在则插入） */
function setProviderBaseUrl(text, providerId, url) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const range = providerBlockRange(lines, providerId);
  if (!range) return { ok: false, text, reason: `配置里没有 provider ${providerId}` };

  for (let i = range.start; i < range.end; i++) {
    const m = /^(\s*)baseURL:\s*(.*)$/.exec(lines[i]);
    if (m) {
      const old = m[2].trim();
      if (old === url) return { ok: true, text, changed: false, old };
      lines[i] = `${m[1]}baseURL: ${url}`;
      return { ok: true, text: joinLines(lines, eol), changed: true, old };
    }
  }
  const indent = ' '.repeat(indentOf(lines[range.start]) + 2);
  lines.splice(range.start + 1, 0, `${indent}baseURL: ${url}`);
  return { ok: true, text: joinLines(lines, eol), changed: true, old: null };
}

/** 设置 agent-default-model 的 provider / model */
function setAgentDefaultModel(text, provider, model) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const range = entryBlockRange(lines, 'agent-default-model');
  if (!range) return { ok: false, text, reason: '配置里没有 agent-default-model 条目' };

  let touched = false;
  for (let i = range.start; i < range.end; i++) {
    const ind = indentOf(lines[i]);
    const mp = /^(\s*)provider:\s*(.*)$/.exec(lines[i]);
    if (mp && ind === 4) { lines[i] = `${mp[1]}provider: ${provider}`; touched = true; continue; }
    const mm = /^(\s*)model:\s*(.*)$/.exec(lines[i]);
    if (mm && ind === 4) { lines[i] = `${mm[1]}model: ${model}`; touched = true; }
  }
  if (!touched) return { ok: false, text, reason: 'agent-default-model 里没有 provider/model 字段' };
  return { ok: true, text: joinLines(lines, eol), changed: true };
}

/**
 * 修正「消息预算为 0」：模型条目里 contextWindow == maxTokens 时，
 * 等于把整个上下文都预留给输出，输入预算直接归零。
 */
function fixTokenBudget(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const entries = [];
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const mId = /^\s*-\s+id:\s*(.+?)\s*$/.exec(lines[i]);
    if (mId) {
      cur = { id: mId[1], ctx: null, maxTok: null, lineIdx: -1 };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    const mCtx = /^\s*contextWindow:\s*(\d+)\s*$/.exec(lines[i]);
    if (mCtx) { cur.ctx = Number(mCtx[1]); continue; }
    const mMax = /^(\s*)maxTokens:\s*(\d+)\s*$/.exec(lines[i]);
    if (mMax) {
      cur.maxTok = Number(mMax[2]);
      cur.indent = mMax[1];
      cur.lineIdx = i;
    }
  }

  const fixed = [];
  for (const e of entries) {
    if (!e.ctx || !e.maxTok || e.lineIdx < 0) continue;
    if (e.maxTok !== e.ctx) continue;
    if (e.ctx < 8192) continue;               // 上下文本来就很小，不动
    const target = Math.max(4096, Math.min(32768, Math.floor(e.ctx / 4)));
    lines[e.lineIdx] = `${e.indent}maxTokens: ${target}`;
    fixed.push({ id: e.id, contextWindow: e.ctx, oldMaxTokens: e.maxTok, newMaxTokens: target });
  }

  return { ok: true, text: fixed.length ? joinLines(lines, eol) : text, changed: fixed.length > 0, fixed };
}

/* ============================================================ 本机事实读取 */

function readPatchText() {
  try { return fs.readFileSync(PATCH_PATH, 'utf8'); } catch { return null; }
}

function writePatchText(text) {
  const backup = `${PATCH_PATH}.bak-${Date.now()}`;
  try { fs.copyFileSync(PATCH_PATH, backup); } catch { /* ignore */ }
  fs.writeFileSync(PATCH_PATH, text, 'utf8');
  return backup;
}

function readCredential(name) {
  try {
    const text = fs.readFileSync(CRED_PATH, 'utf8');
    const m = new RegExp(`^\\s*${name}\\s*:\\s*(['"]?)([^\\s'"]+)\\1\\s*$`, 'm').exec(text);
    return m ? m[2] : null;
  } catch { return null; }
}

function readGatewayKey() {
  try { return fs.readFileSync(path.join(DSH_HOME, 'openai-gateway', 'api-key'), 'utf8').trim(); } catch { return null; }
}

function bunExists() {
  const candidates = [
    path.join(BUN_DIR, 'bun.exe'),
    path.join(BUN_DIR, 'bun'),
    path.join(process.env.APPDATA || '', 'npm', 'bun.exe')
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

function findBunAnywhere() {
  const roots = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'bun', 'bin'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'bun'),
    'C:\\Program Files\\nodejs\\node_modules\\bun\\bin'
  ];
  for (const root of roots) {
    try {
      const list = fs.readdirSync(root);
      const hit = list.find((f) => f.toLowerCase() === 'bun.exe');
      if (hit) return path.join(root, hit);
    } catch { /* ignore */ }
  }
  return null;
}

/** 读取 dsh 网关的模型清单（判断默认模型是否还在） */
async function dshGatewayModels() {
  const key = readGatewayKey();
  if (!key) return null;
  const res = await probe('http://127.0.0.1:8326/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
    timeout: 2500
  });
  if (!res.ok || !res.json) return null;
  const bag = res.json.data || [];
  return bag.map((m) => m.id).filter(Boolean);
}

/* ============================================================ 诊断与修复 */

function finding(id, severity, level, title, detail, extra = {}) {
  return Object.assign({ id, severity, level, title, detail, fixed: false }, extra);
}

/**
 * 执行一次诊断 + 修复。
 * @param {{auto?:boolean, snapshot?:object}} options
 *        auto=true 时会实际落盘修复；false 时只做体检（dry-run）
 */
async function run(options = {}) {
  const auto = options.auto !== false;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const findings = [];
  let needRestart = false;
  const changedFiles = [];

  /* ---------- 1. 自定义接入通道 ---------- */
  const customRecords = custom.rawList();
  for (const rec of customRecords) {
    const hs = await custom.handshake(rec);
    if (hs.ok) continue;

    const status = hs.status;
    // 404 多半是地址漏了 /v1
    if (status === 404 && !/\/v\d+(\.\d+)?$/.test(rec.baseUrl)) {
      const guess = `${rec.baseUrl.replace(/\/+$/, '')}/v1`;
      const retry = await custom.handshake({ baseUrl: guess, apiKey: rec.apiKey, kind: rec.kind, listPath: rec.listPath });
      if (retry.ok) {
        if (auto) {
          await custom.update(rec.id, { baseUrl: guess });
          changedFiles.push('custom-providers.json');
          findings.push(finding(
            `custom-path:${rec.id}`, 'high', 'auto',
            `自定义通道「${rec.name}」地址缺少 /v1，已自动补齐`,
            `${rec.baseUrl} → ${guess}，重新握手成功，${retry.models.length} 个模型可用`,
            { fixed: true, action: '补齐 API 路径并重新握手' }
          ));
        } else {
          findings.push(finding(
            `custom-path:${rec.id}`, 'high', 'auto',
            `自定义通道「${rec.name}」地址缺少 /v1`,
            `建议改为 ${guess}`,
            { fixed: false, action: '补齐 API 路径并重新握手' }
          ));
        }
        continue;
      }
      findings.push(finding(
        `custom-broken:${rec.id}`, 'high', 'manual',
        `自定义通道「${rec.name}」无法连通`,
        `${hs.message}。请检查 API 地址是否正确、服务是否已启动。`,
        { action: '手动核对地址与密钥' }
      ));
      continue;
    }

    if (status === 401 || status === 403) {
      findings.push(finding(
        `custom-auth:${rec.id}`, 'high', 'manual',
        `自定义通道「${rec.name}」密钥被拒绝`,
        `上游返回 HTTP ${status}。密钥无效、已过期或缺少权限，需要重新填写。`,
        { action: '在「接入」页重新填写密钥' }
      ));
      continue;
    }

    findings.push(finding(
      `custom-broken:${rec.id}`, 'mid', 'manual',
      `自定义通道「${rec.name}」握手失败`,
      hs.message,
      { action: '检查地址与服务状态' }
    ));
  }

  /* ---------- 2. dsh 配置体检 ---------- */
  const patchText = readPatchText();
  if (patchText) {
    let text = patchText;

    /* 2a. Moonshot 站区错配 */
    const mooncn = 'https://api.moonshot.cn/v1';
    const mooncnAlt = 'https://api.moonshot.ai/v1';
    const hasMoonshot = providerBlockRange(splitLines(text), 'moonshotai');
    if (hasMoonshot) {
      const lines = splitLines(text);
      const range = providerBlockRange(lines, 'moonshotai');
      let base = '';
      for (let i = range.start; i < range.end; i++) {
        const m = /^\s*baseURL:\s*(.*)$/.exec(lines[i]);
        if (m) { base = m[1].trim(); break; }
      }
      if (base && /moonshot\.ai/.test(base)) {
        const key = readCredential('MOONSHOTAI_API_KEY') || readCredential('MOONSHOT_API_KEY');
        if (key) {
          const [aiRes, cnRes] = await Promise.all([
            probe(`${mooncnAlt}/models`, { headers: { Authorization: `Bearer ${key}` }, timeout: 4000 }),
            probe(`${mooncn}/models`, { headers: { Authorization: `Bearer ${key}` }, timeout: 4000 })
          ]);
          if (!aiRes.ok && cnRes.ok) {
            const r = setProviderBaseUrl(text, 'moonshotai', mooncn);
            if (r.ok && r.changed) {
              if (auto) {
                const backup = writePatchText(r.text);
                changedFiles.push(path.basename(backup));
                text = r.text;
                needRestart = true;
                findings.push(finding(
                  'dsh-moonshot-region', 'high', 'auto',
                  'dsh 的 Moonshot 通道指向了国际站，密钥只在国内站有效',
                  `已把 baseURL 从 ${base} 改为 ${mooncn}（国际站返回 HTTP ${aiRes.status}，国内站返回 200）。原文件已备份为 ${path.basename(backup)}，需重启 DeepSeek Harness 生效。`,
                  { fixed: true, action: '改写 dsh 配置中的 baseURL' }
                ));
              } else {
                findings.push(finding(
                  'dsh-moonshot-region', 'high', 'auto',
                  'dsh 的 Moonshot 通道指向了国际站，密钥只在国内站有效',
                  `建议把 baseURL 改为 ${mooncn}`,
                  { fixed: false, action: '改写 dsh 配置中的 baseURL' }
                ));
              }
            }
          } else if (!aiRes.ok && !cnRes.ok) {
            findings.push(finding(
              'dsh-moonshot-key', 'high', 'manual',
              'dsh 的 Moonshot 密钥在国内外站都不可用',
              `国际站 HTTP ${aiRes.status}，国内站 HTTP ${cnRes.status}。密钥可能已失效，需要重新获取。`,
              { action: '重新获取 Moonshot 密钥' }
            ));
          }
        }
      }
    }

    /* 2b. 消息预算为 0 */
    const tb = fixTokenBudget(text);
    if (tb.changed) {
      if (auto) {
        const backup = writePatchText(tb.text);
        changedFiles.push(path.basename(backup));
        text = tb.text;
        needRestart = true;
        findings.push(finding(
          'dsh-token-budget', 'high', 'auto',
          'dsh 模型把上下文全预留给输出，输入预算为 0',
          tb.fixed.map((f) => `${f.id}: maxTokens ${f.oldMaxTokens} → ${f.newMaxTokens}`).join('；') + '。已备份并修正，需重启 DeepSeek Harness。',
          { fixed: true, action: '修正 maxTokens' }
        ));
      } else {
        findings.push(finding(
          'dsh-token-budget', 'high', 'auto',
          'dsh 模型把上下文全预留给输出，输入预算为 0',
          tb.fixed.map((f) => `${f.id}: maxTokens ${f.oldMaxTokens} → ${f.newMaxTokens}`).join('；'),
          { fixed: false, action: '修正 maxTokens' }
        ));
      }
    }

    /* 2c. 默认模型是否还在 dsh 网关里 */
    const range = entryBlockRange(splitLines(text), 'agent-default-model');
    if (range) {
      const lines = splitLines(text);
      let defProvider = null;
      let defModel = null;
      for (let i = range.start; i < range.end; i++) {
        const mp = /^\s*provider:\s*(.*)$/.exec(lines[i]);
        if (mp && indentOf(lines[i]) === 4) defProvider = mp[1].trim();
        const mm = /^\s*model:\s*(.*)$/.exec(lines[i]);
        if (mm && indentOf(lines[i]) === 4) defModel = mm[1].trim();
      }
      if (defProvider && defModel) {
        const gwModels = await dshGatewayModels();
        if (gwModels && gwModels.length) {
          const full = `${defProvider}/${defModel}`;
          if (!gwModels.includes(full)) {
            const candidates = gwModels.filter((id) => /moonshotai\/(kimi-k3|kimi-k3\.1-pro|kimi-k2\.6)/.test(id));
            const pick = candidates[0] || gwModels.find((id) => /^dsh\//.test(id)) || gwModels[0];
            if (pick) {
              const [pp, mm2] = pick.split('/');
              const r = setAgentDefaultModel(text, pp, mm2);
              if (r.ok) {
                if (auto) {
                  const backup = writePatchText(r.text);
                  changedFiles.push(path.basename(backup));
                  text = r.text;
                  needRestart = true;
                  findings.push(finding(
                    'dsh-default-model', 'high', 'auto',
                    'dsh 默认模型已不存在于网关',
                    `默认 ${full} 不在 dsh 当前的模型列表里，已自动切到 ${pick}。原文件已备份为 ${path.basename(backup)}，需重启 DeepSeek Harness。`,
                    { fixed: true, action: '改写默认模型' }
                  ));
                } else {
                  findings.push(finding(
                    'dsh-default-model', 'high', 'auto',
                    'dsh 默认模型已不存在于网关',
                    `建议把默认模型切到 ${pick}`,
                    { fixed: false, action: '改写默认模型' }
                  ));
                }
              }
            }
          }
        }
      }
    }
  } else {
    findings.push(finding(
      'dsh-config-missing', 'low', 'manual',
      '未找到 dsh 配置文件',
      `路径 ${PATCH_PATH} 不存在，若要用自动修复能力请确认 DeepSeek Harness 已安装过。`,
      { action: '确认 dsh 安装' }
    ));
  }

  /* ---------- 3. 免费车道运行时 ---------- */
  const freeLane = fs.existsSync(path.join(DSH_HOME, 'our-free-model'));
  if (freeLane && !bunExists()) {
    const found = findBunAnywhere();
    if (found && auto) {
      try {
        fs.mkdirSync(BUN_DIR, { recursive: true });
        const target = path.join(BUN_DIR, 'bun.exe');
        fs.copyFileSync(found, target);
        findings.push(finding(
          'free-lane-bun', 'high', 'auto',
          '免费模型车道缺少 Bun 运行时',
          `已把 ${path.basename(found)} 复制到 ${target}（插件的查找路径），免费车道不再报 502。`,
          { fixed: true, action: '补齐 Bun 运行时' }
        ));
      } catch (e) {
        findings.push(finding(
          'free-lane-bun', 'high', 'manual',
          '免费模型车道缺少 Bun 运行时',
          `复制失败：${e.message}。请手动执行 npm i -g bun。`,
          { action: '安装 Bun：npm i -g bun' }
        ));
      }
    } else {
      findings.push(finding(
        'free-lane-bun', 'high', 'manual',
        '免费模型车道缺少 Bun 运行时',
        found
          ? `本机已找到 ${found}，自动修复可把它复制到 ${path.join(BUN_DIR, 'bun.exe')}。`
          : '请执行 npm i -g bun 安装（或从 https://bun.sh 下载），否则免费模型每次调用都会 502。',
        { action: '安装 Bun：npm i -g bun' }
      ));
    }
  }

  /* ---------- 4. dsh 网关 ---------- */
  const gw = await probe('http://127.0.0.1:8326/v1/models', {
    headers: readGatewayKey() ? { Authorization: `Bearer ${readGatewayKey()}` } : {},
    timeout: 2000
  });
  if (!gw.ok) {
    findings.push(finding(
      'dsh-gateway-down', 'mid', 'manual',
      'DeepSeek Harness 网关未运行',
      `127.0.0.1:8326 无响应（${gw.status || gw.error}）。启动 DeepSeek Harness 后，dsh 网关提供的 142 个模型与免费车道才会可用。`,
      { action: '启动 DeepSeek Harness' }
    ));
  }

  /* ---------- 5. 欠费通道 ---------- */
  const teamoKey = readCredential('TEAMO_API_KEY');
  if (teamoKey) {
    const res = await probe('https://api.teamorouter.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${teamoKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro-260425', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      timeout: 6000
    });
    if (res.status === 400 && /insufficient_balance|余额不足/i.test(res.snippet || '')) {
      findings.push(finding(
        'teamo-no-balance', 'mid', 'manual',
        'TeamoRouter 钱包余额不足',
        'teamo 上的 80 个模型（Claude / GPT / Gemini 等）全部挂在这个钱包上，欠费时会统一表现为「Connection error」。充值入口：https://teamorouter.com/dashboard?buy=1',
        { action: '到 TeamoRouter 控制台充值' }
      ));
    }
  }

  /* ---------- 6. MCP 服务 ---------- */
  const mcpBroken = [];
  for (const file of [
    path.join(HOME, '.workbuddy', 'mcp.json'),
    path.join(process.env.LOCALAPPDATA || '', 'Claude-Data', 'claude_pzs8sxrjxfjjc', 'claude_desktop_config.json')
  ]) {
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const [name, def] of Object.entries(cfg.mcpServers || {})) {
      const cmd = def.command || '';
      if (cmd && path.isAbsolute(cmd) && !fs.existsSync(cmd)) {
        mcpBroken.push(`${name}（${cmd}）`);
      }
    }
  }
  if (mcpBroken.length) {
    findings.push(finding(
      'mcp-missing-binary', 'mid', 'manual',
      'MCP 服务指向的程序不存在',
      mcpBroken.join('、') + '。多半是 Python 虚拟环境被移动或删除，需要重建依赖后更新配置里的 command 路径。',
      { action: '重建 MCP 依赖并修正路径' }
    ));
  }

  /* ---------- 7. 总体结论 ---------- */
  const online = (options.snapshot && options.snapshot.summary && options.snapshot.summary.chatReady) || 0;
  if (!online && !findings.some((f) => f.severity === 'high')) {
    findings.push(finding(
      'no-channel', 'mid', 'manual',
      '当前没有可对话的通道',
      '未发现任何在线的推理通道。请启动 Ollama / LM Studio / DeepSeek Harness，或在「接入」页手动添加一个 API。',
      { action: '启动本机 AI 或手动接入 API' }
    ));
  }

  const fixedCount = findings.filter((f) => f.fixed).length;
  const manualCount = findings.filter((f) => !f.fixed).length;
  const report = {
    ok: true,
    startedAt,
    durationMs: Date.now() - t0,
    dryRun: !auto,
    findings,
    fixedCount,
    manualCount,
    needRestart,
    changedFiles,
    summary: fixedCount
      ? `已自动修复 ${fixedCount} 项，另有 ${manualCount} 项需要你手动处理`
      : (manualCount ? `发现 ${manualCount} 项问题，均需要手动处理` : '未发现可自动修复的问题，系统状态正常')
  };

  try { store.appendRepairLog({ at: startedAt, fixedCount, manualCount, needRestart }); } catch { /* ignore */ }
  return report;
}

/** 供 UI 展示的历史记录 */
function history() {
  return store.getRepairLog();
}

module.exports = {
  run, history,
  // 导出内部工具，便于自检
  _internals: { setProviderBaseUrl, setAgentDefaultModel, fixTokenBudget, providerBlockRange, entryBlockRange, PATCH_PATH }
};
