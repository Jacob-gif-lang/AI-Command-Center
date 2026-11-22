'use strict';
/**
 * 本地服务层（Local Service Layer）
 * ------------------------------------------------------------
 * 同一套代码有两种宿主：
 *   A. Electron 主进程内 require → 同进程起 HTTP，渲染层走 http://127.0.0.1:port
 *   B. 纯 Node（npm run web）    → 便于开发调试与无 Electron 环境降级
 *
 * 之所以不用 IPC 直连而统一走 HTTP：
 *   1. 渲染层可以脱离 Electron 在浏览器里独立跑，便于调试与预览；
 *   2. 后续做「多端接管」时，手机/平板也能连同一个本机端口；
 *   3. SSE 天然适配流式输出，比 IPC 手工拼事件更稳。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const detector = require('./detector');
const providers = require('./providers');
const store = require('./store');
const custom = require('./custom');
const repair = require('./repair');
const free = require('./free');
const group = require('./group');
const plugins = require('./plugins');
const audio = require('./audio');
const modelPicker = require('./model-picker');
const feedback = require('./feedback');
const smtp = require('./smtp');
const update = require('./update');

const APP_VERSION = '0.7.2';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const STARTED_AT = Date.now();

/* 正在输出的流：requestId -> AbortController。
 * 前端点「停止」时会同时中断浏览器 fetch 并调用 /api/*\/stop；
 * 即使浏览器连接尚未关闭，这里也能第一时间掐断上游推理（含思考链）。 */
const activeChats = new Map();
const activeGroups = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

/* --------------------------------------------------------------- 快照缓存 */

let snapshot = store.getSnapshot();
let inflightDetect = null;

async function getSnapshot(force = false, deep = false) {
  // 快照缓存 2 分钟：避免每次刷新都去打云端 /models，减少无谓的额度与请求消耗
  // 全盘识别（deep）永远强制重扫，且不与普通探测共享 in-flight，避免拿到浅扫描结果。
  const fresh = snapshot && !deep && Date.now() - new Date(snapshot.generatedAt).getTime() < 120000;
  if (!force && !deep && fresh) return snapshot;
  if (inflightDetect && !deep) return inflightDetect;
  const task = detector
    .detect({ timeout: store.getSettings().scanTimeoutMs, deep })
    .then((snap) => {
      snapshot = snap;
      store.saveSnapshot(snap);
      return snap;
    });
  if (!deep) {
    inflightDetect = task.finally(() => { inflightDetect = null; });
    return inflightDetect;
  }
  return task;
}

function findProvider(id) {
  if (!snapshot) return null;
  return (snapshot.providers || []).find((p) => p.id === id) || null;
}

/* ----------------------------------------------------------------- 工具 */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(RENDERER_DIR, decodeURIComponent(rel));
  if (!filePath.startsWith(RENDERER_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------ SSE 对话流 */

async function handleChat(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'invalid_body', message: e.message });
  }

  let {
    providerId = 'demo',
    model,
    messages = [],
    temperature,
    maxTokens,
    purpose = 'chat',
    requestId = null,
    // 请求级深度思考开关：未在前端开启时为 null，完全跟随设置；
    // true 会强制打开 thinking（含 Ollama 与兼容接口），false 强制关闭。
    think = null
  } = body || {};

  const requested = providerId === 'demo'
    ? { id: 'demo', name: 'NEXUS Demo', chatCapable: true, kind: 'demo' }
    : findProvider(providerId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  if (requestId) activeChats.set(requestId, ctrl);
  const release = () => {
    if (requestId && activeChats.get(requestId) === ctrl) activeChats.delete(requestId);
  };
  res.once('close', release);

  const push = (obj) => {
    if (res.writableEnded) return;
    if (ctrl.signal.aborted && obj.type !== 'stopped') return;
    res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  };

  // 插件安装意图：用户说「下载/安装 XX 插件」时，先自动安装并推送系统回执，
  // 再把「安装结果」作为上下文交给模型，让它用自然语言确认。
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const pluginHit = lastUser ? plugins.detectIntent(lastUser.content) : null;
  if (pluginHit) {
    const result = plugins.install(lastUser.content);
    push({
      type: 'plugin',
      action: result.action,
      plugin: result.plugin,
      ok: result.ok,
      message: result.message,
      needRescan: !!result.needRescan
    });
    if (result.needRescan) {
      // 装完即刻刷新拓扑，让新插件进入 AI 列表
      getSnapshot(true).catch(() => {});
    }
    // 把安装结果塞进消息尾部，让模型据此给出确认回复
    messages = messages.map((m, i) => m === lastUser
      ? Object.assign({}, m, { content: `${m.content}\n\n【系统提示：插件安装结果】${result.message}` })
      : m);
  }

  // 发言人候选序列：
  //   - 被请求节点自己若能推理，排第一；
  //   - 其后依次是免费通道与其它在线通道。
  // 若首选返回空文本或报错（本机通道「显示在线但实际不可用」很常见），
  // 自动回退到下一个候选，保证「每个 AI 都能说话」。
  const pool = (snapshot && snapshot.providers) || [];
  const candidates = providerId === 'demo'
    ? [requested]
    : free.speakerCandidates(pool, providerId).slice(0, 4);

  if (!candidates.length) {
    push({
      type: 'error',
      code: 'no_speaker',
      message: '当前没有任何可用的发言通道。',
      hint: '请检查网络后点「重新识别」，或到「模型接入」添加一个 API 通道。'
    });
    res.end();
    return;
  }

  // 请求可能在等待候选/插件安装期间就被取消
  if (ctrl.signal.aborted) {
    push({ type: 'stopped', message: '已停止输出与思考' });
    res.end();
    return;
  }

  let lastErr = null;
  let done = false;

  for (const speaker of candidates) {
    if (ctrl.signal.aborted) break;
    const isSelf = speaker.id === providerId;
    const bridge = isSelf ? null : {
      requestedId: providerId,
      requestedName: requested ? requested.name : providerId,
      speakerId: speaker.id,
      speakerName: speaker.name,
      reason: requested && !free.canSpeak(requested)
        ? '该节点无法直接推理，已自动切换'
        : '首选通道无响应，已自动切换'
    };
    // 桥接时改用实际发言人的可用模型，避免把被桥接节点的 model 传给别的后端
    let effectiveModel = bridge
      ? (speaker.models && speaker.models[0] && speaker.models[0].id) || model
      : model;

    // 本地模型智能选择：没手动指定模型时，按问题复杂度自动挑最快够用的模型。
    // 用户在设置页可以用 localModelPolicy / pinnedLocalModel 覆盖。
    let localChoice = null;
    const settings = store.getSettings();
    if (!effectiveModel || settings.localModelPolicy !== 'manual') {
      localChoice = modelPicker.pickLocalModel(speaker, messages, settings);
      if (localChoice) effectiveModel = localChoice.model;
    }

    // 深度思考：前端开关 > 智能选模型建议 > 全局设置。
    // 这样即使在「最快」策略下，用户点开深度思考也能强制开启。
    const effectiveThink = typeof think === 'boolean'
      ? think
      : (localChoice ? localChoice.think : settings.ollamaThink === true);

    push({
      type: 'meta',
      providerId,
      providerName: requested ? requested.name : providerId,
      model: effectiveModel || null,
      purpose,
      bridge,
      speakerId: speaker.id,
      speakerName: speaker.name,
      think: !!effectiveThink,
      modelChoice: localChoice ? {
        model: localChoice.model,
        reason: localChoice.reason,
        complexity: localChoice.complexity
      } : null
    });

    let emitted = false;
    try {
      const result = await providers.streamChat(speaker, {
        model: effectiveModel,
        messages,
        temperature,
        maxTokens,
        numCtx: localChoice ? localChoice.numCtx : undefined,
        think: effectiveThink,
        signal: ctrl.signal,
        onDelta: (text) => {
          if (!text || ctrl.signal.aborted) return;
          emitted = true;
          push({ type: 'delta', text });
        },
        onThinking: (text) => {
          if (!text || ctrl.signal.aborted) return;
          push({ type: 'thinking', text });
        }
      });
      if (ctrl.signal.aborted) break;
      const finalText = (result.text && result.text.trim())
        ? result.text
        : (result.reasoning || '').trim();

      // 空响应且没有任何增量输出 → 视为该通道不可用，回退到下一个候选
      if (!finalText && !emitted) {
        lastErr = Object.assign(new Error('通道返回空响应'), { code: 'empty_response' });
        continue;
      }
      push({
        type: 'done',
        text: finalText,
        reasoned: !result.text && !!result.reasoning,
        // 回传完整思维链，前端可据此补全/回看「已深度思考」内容
        reasoning: result.reasoning || '',
        think: !!effectiveThink,
        model: result.model || effectiveModel || model || null,
        usage: result.usage || null
      });
      done = true;
      break;
    } catch (err) {
      // 用户主动停止：不再回退、不再报错，避免停止后又冒出别的模型在说
      if (ctrl.signal.aborted || (err && err.code === 'aborted')) break;
      // 尚未输出任何内容就失败 → 可安全回退（客户端没看到半成品）
      if (!emitted) { lastErr = err; continue; }
      push({
        type: 'error',
        code: err.code || 'upstream_error',
        message: err.message || '上游调用失败',
        hint: err.hint || ''
      });
      done = true;
      break;
    }
  }

  if (ctrl.signal.aborted) {
    push({ type: 'stopped', message: '已停止输出与思考' });
  } else if (!done) {
    push({
      type: 'error',
      code: lastErr && lastErr.code !== 'empty_response' ? lastErr.code : 'no_speaker',
      message: lastErr && lastErr.code !== 'empty_response'
        ? lastErr.message
        : '所有在线通道都返回了空响应，请检查网络或点「重新识别」。',
      hint: '可到「模型接入」添加一个 API 通道，或开启「免费兜底模型」。'
    });
  }
  res.end();
}

/* ---------------------------------------------------------------- 路由 */

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const { pathname, searchParams } = url;

  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      app: 'NEXUS',
      version: APP_VERSION,
      canUpdate: true,
      backend: true,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      providers: snapshot ? snapshot.summary : null,
      customCount: store.getCustomProviders().length,
      dataDir: store.ROOT,
      platform: process.platform
    });
  }

  /* ---- 软件自更新 ---- */
  if (pathname === '/api/update/check' && req.method === 'GET') {
    try {
      const feedUrl = store.getSettings().updateFeedUrl;
      const result = await update.check(APP_VERSION, {
        force: searchParams.get('force') === '1',
        feedUrl,
        platform: process.platform,
        arch: process.arch
      });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 200, {
        current: APP_VERSION, available: false, offLine: true,
        error: err.message || '检查更新失败', package: null, notes: []
      });
    }
  }

  if (pathname === '/api/update/download' && req.method === 'POST') {
    try {
      const body = await readBody(req).catch(() => ({}));
      const pkg = body && body.package ? body.package : null;
      if (!pkg || !pkg.file) return sendJson(res, 400, { error: '缺少安装包信息' });
      const result = update.startDownload(pkg, { feedUrl: store.getSettings().updateFeedUrl });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message || '无法开始下载' });
    }
  }

  if (pathname === '/api/update/progress' && req.method === 'GET') {
    return sendJson(res, 200, update.getJob(searchParams.get('jobId') || ''));
  }

  if (pathname === '/api/update/cancel' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return sendJson(res, 200, { ok: update.cancel(body.jobId) });
  }

  if (pathname === '/api/update/verify' && req.method === 'POST') {
    // 供 Electron 主进程在打开前再次确认路径安全（前端只拿到文件名，不直接给主进程任意路径）
    const body = await readBody(req).catch(() => ({}));
    const safe = update.safeLocalPath(body.path);
    return sendJson(res, 200, { ok: !!safe, path: safe || null });
  }

  if (pathname === '/api/providers' && req.method === 'GET') {
    const force = searchParams.get('refresh') === '1';
    const snap = await getSnapshot(force);
    return sendJson(res, 200, snap);
  }

  if (pathname === '/api/detect' && req.method === 'POST') {
    const snap = await getSnapshot(true);
    return sendJson(res, 200, snap);
  }

  // 全盘识别：扫描整台电脑寻找 AI 模型（含非默认盘符、独立 GGUF 文件）
  if (pathname === '/api/detect/deep' && req.method === 'POST') {
    const snap = await getSnapshot(true, true);
    return sendJson(res, 200, snap);
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    return handleChat(req, res);
  }

  // 显式停止：前端点按钮时调用，确保上游推理（含 thinking）立即掐断
  if (pathname === '/api/chat/stop' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const ctrl = body.requestId && activeChats.get(body.requestId);
    if (!ctrl) return sendJson(res, 200, { ok: false, stopped: false, reason: 'not_found' });
    ctrl.abort();
    return sendJson(res, 200, { ok: true, stopped: true });
  }

  // 微信群聊式多人对话：SSE 流式推送每位成员的消息事件
  if (pathname === '/api/group' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());
    const requestId = body.requestId || null;
    if (requestId) activeGroups.set(requestId, ctrl);
    const release = () => {
      if (requestId && activeGroups.get(requestId) === ctrl) activeGroups.delete(requestId);
    };
    res.once('close', release);

    const push = (obj) => {
      if (res.writableEnded) return;
      if (ctrl.signal.aborted && obj.type !== 'stopped') return;
      res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
    };
    const snap = await getSnapshot(false).catch(() => snapshot);
    // group.run 自身会在取消时发 stopped 事件，这里不再重复推送
    await group.run({
      mode: body.mode,
      question: body.question,
      members: body.members,
      snapshot: snap,
      maxTokens: body.maxTokens,
      signal: ctrl.signal,
      onEvent: push
    });
    res.end();
    return;
  }

  if (pathname === '/api/group/stop' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const ctrl = body.requestId && activeGroups.get(body.requestId);
    if (!ctrl) return sendJson(res, 200, { ok: false, stopped: false, reason: 'not_found' });
    ctrl.abort();
    return sendJson(res, 200, { ok: true, stopped: true });
  }

  if (pathname === '/api/settings') {
    if (req.method === 'GET') return sendJson(res, 200, store.getSettings());
    if (req.method === 'POST') {
      const patch = await readBody(req).catch(() => ({}));
      return sendJson(res, 200, store.saveSettings(patch));
    }
  }

  if (pathname === '/api/flows') {
    if (req.method === 'GET') return sendJson(res, 200, store.getFlows());
    if (req.method === 'POST') {
      const payload = await readBody(req).catch(() => null);
      if (!payload) return sendJson(res, 400, { error: 'invalid_body' });
      return sendJson(res, 200, store.saveFlows(payload));
    }
  }

  /* ------------------------------------------------ 自定义接入（手填 API） */

  if (pathname === '/api/custom-providers') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { providers: custom.listAll() });
    }
    if (req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const result = await custom.create(body);
      if (!result.ok) return sendJson(res, 400, { error: 'invalid', message: result.error });
      await getSnapshot(true);
      return sendJson(res, 200, result);
    }
  }

  // /api/custom-providers/probe —— 只测不存
  if (pathname === '/api/custom-providers/probe' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const result = await custom.handshake({
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      kind: body.kind,
      listPath: body.listPath
    });
    return sendJson(res, 200, result);
  }

  // /api/custom-providers/:id —— 更新 / 删除 / 刷新模型 / 用已存密钥复测
  const cpMatch = /^\/api\/custom-providers\/([^/]+)(?:\/(refresh|test))?$/.exec(pathname);
  if (cpMatch) {
    const id = decodeURIComponent(cpMatch[1]);
    if (req.method === 'PUT' || req.method === 'PATCH') {
      const body = await readBody(req).catch(() => ({}));
      const result = await custom.update(id, body);
      if (!result.ok) return sendJson(res, 404, { error: 'not_found', message: result.error });
      await getSnapshot(true);
      return sendJson(res, 200, result);
    }
    if (req.method === 'DELETE') {
      const result = custom.remove(id);
      if (!result.ok) return sendJson(res, 404, { error: 'not_found', message: result.error });
      await getSnapshot(true);
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && cpMatch[2] === 'refresh') {
      const result = await custom.refreshModels(id);
      if (!result.ok) return sendJson(res, 404, { error: 'not_found', message: result.error });
      await getSnapshot(true);
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && cpMatch[2] === 'test') {
      // 密钥只存在服务端，用保存的记录原地复测，绝不回传明文
      const rec = custom.rawList().find((p) => p.id === id);
      if (!rec) return sendJson(res, 404, { error: 'not_found', message: '未找到该通道' });
      const result = await custom.handshake(rec);
      return sendJson(res, 200, Object.assign({ name: rec.name }, result));
    }
  }

  /* ------------------------------------------------------------ 自愈修复 */

  if (pathname === '/api/repair' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    // 把当前拓扑一并交给诊断器，避免「明明有在线通道却报无通道」的误判
    let snap = null;
    try { snap = await getSnapshot(false); } catch { snap = snapshot; }
    const report = await repair.run({ auto: body.auto !== false, snapshot: snap });
    if (report.fixedCount) {
      // 修复后刷新一次拓扑，让 UI 立刻反映新状态
      try { await getSnapshot(true); } catch { /* ignore */ }
    }
    return sendJson(res, 200, report);
  }

  if (pathname === '/api/repair/history' && req.method === 'GET') {
    return sendJson(res, 200, { entries: repair.history() });
  }

  /* ------------------------------------------------------------ MCP 插件自动安装 */
  if (pathname === '/api/plugins' && req.method === 'GET') {
    return sendJson(res, 200, { plugins: plugins.list(), history: plugins.history() });
  }
  if (pathname === '/api/plugins/install' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const result = plugins.install(body.text || body.id || body.plugin);
    if (result.needRescan) await getSnapshot(true).catch(() => {});
    return sendJson(res, 200, result);
  }

  /* ------------------------------------------------------------ 系统声音开关 */
  if (pathname === '/api/audio' && req.method === 'GET') {
    return sendJson(res, 200, await audio.status());
  }
  if (pathname === '/api/audio/toggle' && req.method === 'POST') {
    return sendJson(res, 200, await audio.toggle());
  }
  if (pathname === '/api/audio/mute' && req.method === 'POST') {
    return sendJson(res, 200, await audio.mute());
  }
  if (pathname === '/api/audio/unmute' && req.method === 'POST') {
    return sendJson(res, 200, await audio.unmute());
  }

  /* ---------------- 用户优化 · 功能投票 · 邮件反馈 ---------------- */
  if (pathname === '/api/feedback' && req.method === 'GET') {
    return sendJson(res, 200, feedback.getFeedback());
  }
  if (pathname === '/api/feedback/vote' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const result = feedback.vote(body.id, body.delta);
    if (!result) return sendJson(res, 404, { error: 'idea_not_found' });
    return sendJson(res, 200, Object.assign({ ok: true }, result));
  }
  if (pathname === '/api/feedback/idea' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const idea = feedback.addIdea(body.title, body.category);
    if (!idea) return sendJson(res, 400, { error: 'invalid_title' });
    return sendJson(res, 200, { ok: true, idea });
  }
  if (pathname === '/api/feedback/suggest' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const item = feedback.addSuggestion(body);
    if (!item) return sendJson(res, 400, { error: 'invalid_text' });
    return sendJson(res, 200, { ok: true, item });
  }
  if (pathname === '/api/feedback/suggest/remove' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const ok = feedback.removeSuggestion(body.id);
    if (!ok) return sendJson(res, 404, { error: 'suggestion_not_found' });
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/feedback/mark-sent' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return sendJson(res, 200, feedback.markSent(body));
  }
  if (pathname === '/api/feedback/mailto' && req.method === 'GET') {
    const subject = searchParams.get('subject') || 'NEXUS 用户优化反馈';
    return sendJson(res, 200, { ok: true, url: feedback.mailtoUrl(subject, feedback.buildMailBody()), to: feedback.FEEDBACK_EMAIL });
  }
  if (pathname === '/api/feedback/send' && req.method === 'POST') {
    // 优先用设置里的 SMTP 直发；未提供凭据时返回 mailto 让本机邮件客户端接管
    const body = await readBody(req).catch(() => ({}));
    const settings = store.getSettings();
    const cfg = Object.assign({}, settings.smtp || {}, body.smtp || {});
    const text = body.text || feedback.buildMailBody();
    const subject = body.subject || 'NEXUS 用户优化反馈';
    if (cfg.host && cfg.user && cfg.pass) {
      try {
        await smtp.sendMail({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          user: cfg.user,
          pass: cfg.pass,
          from: cfg.from || cfg.user,
          to: feedback.FEEDBACK_EMAIL,
          subject,
          text
        });
        feedback.markSent(body.ids);
        return sendJson(res, 200, { ok: true, method: 'smtp', to: feedback.FEEDBACK_EMAIL });
      } catch (e) {
        return sendJson(res, 200, { ok: false, method: 'smtp', error: e.message,
          mailto: feedback.mailtoUrl(subject, text), to: feedback.FEEDBACK_EMAIL });
      }
    }
    return sendJson(res, 200, { ok: false, method: 'mailto', to: feedback.FEEDBACK_EMAIL,
      mailto: feedback.mailtoUrl(subject, text) });
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'not_found', path: pathname });
  }

  return serveStatic(req, res, pathname);
}

/* ---------------------------------------------------------------- 启动 */

function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: String(err && err.message) });
      else res.end();
    });
  });
}

function listen(server, candidates = [8788, 8790, 9315, 0]) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return reject(new Error('no port available'));
      const port = candidates[i++];
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE') tryNext();
        else reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    tryNext();
  });
}

async function start({ port = 8788, quiet = false } = {}) {
  const server = createServer();
  const actual = await listen(server, [port, port + 2, port + 4, 0]);

  // 若上次异常退出遗留了静音会话，启动时按 SID 精确恢复。
  // 只在确实有遗留记录且有缓存解释器时动作，不安装依赖、不阻塞启动。
  audio.restorePending().catch(() => {});
  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log(`\n  NEXUS v${APP_VERSION}  →  http://127.0.0.1:${actual}\n  data: ${store.ROOT}\n`);
  }

  // 启动即预热探测（后台执行，不阻塞窗口显示）
  getSnapshot(true).then((snap) => {
    if (!quiet) {
      // eslint-disable-next-line no-console
      console.log(`  [detect] ${snap.summary.total} 个对象 · ${snap.summary.chatReady} 条可用对话通道 · ${snap.elapsedMs}ms`);
    }
  }).catch(() => {});

  return { server, port: actual, url: `http://127.0.0.1:${actual}` };
}

module.exports = { start, createServer, APP_VERSION, getSnapshot };

if (require.main === module) {
  start({ port: Number(process.env.NEXUS_PORT) || 8788 }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('启动失败：', err);
    process.exit(1);
  });
}
