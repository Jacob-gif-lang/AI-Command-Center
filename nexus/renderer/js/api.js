'use strict';
/**
 * 渲染层与本地服务的唯一通信口。
 * 三种运行态：
 *   live   —— 命中 /api/health，真实探测与真实推理
 *   demo   —— 未命中（例如直接在浏览器里打开 index.html），使用内置样本数据
 *   error  —— 后端异常
 */
(function () {
  const state = { mode: 'unknown', health: null };

  async function jsonFetch(url, options) {
    const res = await fetch(url, Object.assign({ cache: 'no-store' }, options));
    if (!res.ok) {
      let detail = null;
      try { detail = await res.json(); } catch { /* ignore */ }
      throw Object.assign(new Error((detail && detail.message) || `HTTP ${res.status}`), { status: res.status, detail });
    }
    return res.json();
  }

  async function health() {
    try {
      const data = await jsonFetch('/api/health', { signal: AbortSignal.timeout(2500) });
      state.mode = 'live';
      state.health = data;
      return data;
    } catch {
      state.mode = 'demo';
      return null;
    }
  }

  /* --------------------------------------------------------- 样本数据 */

  function demoSnapshot() {
    const mk = (o) => {
      const p = Object.assign({ models: [], modelCount: 0, latencyMs: 0, chatCapable: true, source: 'demo' }, o);
      // 与服务端一致：工具/宿主应用不是模型
      if (p.kind === 'mcp' || p.kind === 'app') { p.isTool = true; p.category = p.kind === 'mcp' ? 'tool' : 'app'; }
      else p.category = 'model';
      return p;
    };
    return {
      generatedAt: new Date().toISOString(),
      elapsedMs: 842,
      host: 'DESKTOP-DEMO',
      platform: 'Windows 11 25H2',
      demo: true,
      providers: [
        mk({
          id: 'free:pollinations', name: 'NEXUS 免费模型', vendor: 'Pollinations', kind: 'free',
          endpoint: 'https://text.pollinations.ai/openai', status: 'online', latencyMs: 320,
          caps: ['chat', 'free', 'cloud', 'builtin'], detail: '免密钥公共模型 · 无需配置即可使用（匿名额度有限）',
          models: [{ id: 'openai', name: '免费通用 · gpt-oss-20b' }, { id: 'mistral', name: '免费 Mistral（额度收紧）' }, { id: 'llama', name: '免费 Llama' }], modelCount: 6
        }),
        mk({
          id: 'demo', name: 'NEXUS 演示节点', vendor: 'NEXUS', kind: 'demo', endpoint: 'local://demo',
          status: 'online', latencyMs: 12, caps: ['chat', 'offline'], detail: '内置模拟通道，用于零依赖演示',
          models: [{ id: 'nexus-demo', name: 'Nexus Demo 1.0' }], modelCount: 1
        }),
        mk({
          id: 'ollama', name: 'Ollama', vendor: 'Ollama', kind: 'ollama', endpoint: 'http://127.0.0.1:11434',
          status: 'offline', latencyMs: 3, caps: ['chat', 'embedding', 'local'], detail: 'HTTP 0 unreachable',
          models: [], modelCount: 0, chatCapable: true
        }),
        mk({
          id: 'lmstudio', name: 'LM Studio', vendor: 'LM Studio', kind: 'openai', endpoint: 'http://127.0.0.1:1234',
          status: 'offline', latencyMs: 2, caps: ['chat', 'openai-api', 'local'], detail: '未启动', models: [], chatCapable: true
        }),
        mk({
          id: 'cloud:moonshot', name: 'Moonshot / Kimi', vendor: 'Moonshot AI', kind: 'openai',
          endpoint: 'https://api.moonshot.cn/v1', status: 'online', latencyMs: 186,
          caps: ['chat', 'long-context'], detail: '已复用本机凭据 · 12 个模型', source: 'credential-reuse',
          models: [{ id: 'kimi-k2.6', name: 'kimi-k2.6' }, { id: 'moonshot-v1-32k', name: 'moonshot-v1-32k' }], modelCount: 12
        }),
        mk({
          id: 'cloud:teamo', name: 'TeamoRouter', vendor: 'Teamo', kind: 'openai',
          endpoint: 'https://api.teamorouter.com/v1', status: 'restricted', latencyMs: 240,
          caps: ['chat', 'aggregator'], detail: '通道受限（HTTP 400），可能额度不足',
          models: [{ id: 'deepseek-v4-pro-260425', name: 'deepseek-v4-pro' }], modelCount: 80
        }),
        mk({
          id: 'dsh-app', name: 'DeepSeek Harness', vendor: 'DeepSeek', kind: 'app', endpoint: 'C:\\Users\\<user>\\.dsh',
          status: 'installed', caps: ['host', 'mcp', 'multi-model'], detail: '配置目录已识别 · 免费模型目录 12 条',
          models: [], chatCapable: false
        }),
        mk({
          id: 'claude-desktop', name: 'Claude Desktop', vendor: 'Anthropic', kind: 'app',
          endpoint: 'claude_desktop_config.json', status: 'installed', caps: ['host', 'mcp'],
          detail: '已挂载 1 个 MCP 服务', models: [], chatCapable: false
        }),
        mk({
          id: 'mcp:WorkBuddy:windows-mcp', name: 'windows-mcp', vendor: 'WorkBuddy', kind: 'mcp',
          endpoint: 'Windows-MCP\\.venv\\Scripts\\python.exe', status: 'configured', caps: ['tools', 'stdio'],
          detail: 'WorkBuddy · -m windows_mcp serve', models: [], chatCapable: false
        })
      ],
      diskScan: { deep: false, elapsedMs: 15, findings: [], roots: {}, scannedAt: new Date().toISOString() },
      summary: { total: 9, online: 4, chatReady: 4, apps: 2, mcp: 1, tools: 3, models: 98, diskModels: 0 }
    };
  }

  async function providers(force) {
    if (state.mode === 'demo') return demoSnapshot();
    try {
      return await jsonFetch(`/api/providers${force ? '?refresh=1' : ''}`);
    } catch {
      state.mode = 'demo';
      return demoSnapshot();
    }
  }

  async function detect() {
    if (state.mode === 'demo') {
      await new Promise((r) => setTimeout(r, 700));
      return demoSnapshot();
    }
    return jsonFetch('/api/detect', { method: 'POST' });
  }

  /** 全盘识别：扫描整台电脑（含非默认盘符、独立 GGUF 文件），耗时较长 */
  async function deepDetect() {
    if (state.mode === 'demo') {
      await new Promise((r) => setTimeout(r, 1100));
      return demoSnapshot();
    }
    return jsonFetch('/api/detect/deep', { method: 'POST', signal: AbortSignal.timeout(60000) });
  }

  /* ------------------------------------------------------------ 对话流 */

  function demoChat({ messages, onDelta, onThinking, think, signal }) {
    const prompt = (messages.find((m) => m.role === 'user') || {}).content || '';
    const reasoning = think
      ? '（演示思维链）先理解问题，再拆解要点，最后组织成一段清楚的回复。真实模型会在这里逐步推理。'
      : '';
    const text =
      '（预览模式）当前页面没有连上本地服务，这是一段内置的模拟回复。\n\n' +
      `你问的是：「${String(prompt).slice(0, 80)}」\n\n` +
      '正式运行请在项目目录执行 npm start（Electron 窗口）或 npm run web（浏览器模式），' +
      'NEXUS 会在启动时自动扫描本机的 Ollama、LM Studio、DeepSeek Harness、Claude Desktop 等对象，' +
      '并把可用通道挂到侧边的目标列表里。';
    let i = 0;
    let ti = 0;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (signal && signal.aborted) {
          const err = new Error('已停止输出');
          err.name = 'AbortError';
          err.code = 'aborted';
          return reject(err);
        }
        if (reasoning && ti < reasoning.length) {
          const chunk = reasoning.slice(ti, ti + 2);
          ti += 2;
          onThinking && onThinking(chunk);
          return setTimeout(tick, 10);
        }
        if (i >= text.length) return resolve({ text, reasoning, model: 'demo' });
        const step = 2 + Math.floor(Math.random() * 3);
        const chunk = text.slice(i, i + step);
        i += step;
        onDelta && onDelta(chunk);
        setTimeout(tick, 16);
      };
      tick();
    });
  }

  const newRequestId = (prefix) =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  async function chat({ providerId, model, messages, temperature, maxTokens, think, requestId, onRequestId, onDelta, onMeta, onError, onThinking, onPlugin, onStopped, signal }) {
    const reqId = requestId || newRequestId('chat');
    onRequestId && onRequestId(reqId);
    if (state.mode === 'demo') {
      onMeta && onMeta({ providerId, model: model || 'nexus-demo', think: !!think });
      return demoChat({ messages, onDelta, onThinking, think, signal });
    }

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, model, messages, temperature, maxTokens, think: think == null ? null : !!think, requestId: reqId }),
      signal
    });
    if (!res.ok || !res.body) {
      const err = new Error(`HTTP ${res.status}`);
      onError && onError({ message: err.message, code: 'http_' + res.status });
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let failure = null;
    let meta = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.type === 'meta') { meta = evt; onMeta && onMeta(evt); }
        else if (evt.type === 'plugin') { onPlugin && onPlugin(evt); }
        else if (evt.type === 'delta') { text += evt.text; onDelta && onDelta(evt.text); }
        else if (evt.type === 'thinking') { reasoning += evt.text || ''; onThinking && onThinking(evt.text); }
        else if (evt.type === 'stopped') { onStopped && onStopped(evt); }
        else if (evt.type === 'error') { failure = evt; onError && onError(evt); }
        else if (evt.type === 'done') {
          if (!text && evt.text) text = evt.text;
          if (evt.reasoning && !reasoning) reasoning = evt.reasoning;
        }
      }
    }
    if (failure) throw Object.assign(new Error(failure.message), { code: failure.code, hint: failure.hint });
    return { text, reasoning, meta };
  }

  /* ------------------------------------------- 模型接入 / 自愈修复接口 */
  /* 预览模式（直接打开 index.html）没有后端，这里统一给出可读提示 */

  function requireLive(action) {
    if (state.mode === 'demo') {
      throw Object.assign(new Error(`预览模式下无法${action}，请用 npm start 启动桌面版`), { code: 'demo_mode' });
    }
  }

  function postJson(url, payload, method = 'POST') {
    return jsonFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
  }

  const cpUrl = (id, tail = '') => `/api/custom-providers/${encodeURIComponent(id)}${tail}`;

  const admin = {
    listCustom() {
      requireLive('读取自定义通道');
      return jsonFetch('/api/custom-providers');
    },
    probeCustom(payload) {
      requireLive('测试 API 连接');
      return postJson('/api/custom-providers/probe', payload);
    },
    createCustom(payload) {
      requireLive('保存通道');
      return postJson('/api/custom-providers', payload);
    },
    updateCustom(id, payload) {
      requireLive('更新通道');
      return postJson(cpUrl(id), payload, 'PUT');
    },
    deleteCustom(id) {
      requireLive('删除通道');
      return jsonFetch(cpUrl(id), { method: 'DELETE' });
    },
    refreshCustomModels(id) {
      requireLive('刷新模型清单');
      return postJson(cpUrl(id, '/refresh'), {});
    },
    testCustom(id) {
      requireLive('复测通道');
      return postJson(cpUrl(id, '/test'), {});
    },
    repair(auto = true) {
      requireLive('运行诊断修复');
      return postJson('/api/repair', { auto });
    },
    repairHistory() {
      if (state.mode === 'demo') return Promise.resolve({ entries: [] });
      return jsonFetch('/api/repair/history').catch(() => ({ entries: [] }));
    },
    /* 停止当前正在输出的对话 / 群聊（连思考链一起掐断） */
    stopChat(requestId) {
      if (state.mode === 'demo') return Promise.resolve({ ok: true, stopped: true, demo: true });
      return postJson('/api/chat/stop', { requestId });
    },
    stopGroup(requestId) {
      if (state.mode === 'demo') return Promise.resolve({ ok: true, stopped: true, demo: true });
      return postJson('/api/group/stop', { requestId });
    },
    /* 群聊（微信群聊式多人对话） */
    group(payload, onEvent, signal) {
      requireLive('发起群聊');
      const reqId = payload && payload.requestId ? payload.requestId : newRequestId('group');
      if (payload) payload.requestId = reqId;
      return fetch('/api/group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || { requestId: reqId }),
        signal
      }).then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            let evt;
            try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
            onEvent && onEvent(evt);
          }
        }
      });
    },
    /* MCP 插件 */
    listPlugins() {
      requireLive('读取插件列表');
      return jsonFetch('/api/plugins').catch(() => ({ plugins: [], history: [] }));
    },
    installPlugin(input) {
      requireLive('安装插件');
      return postJson('/api/plugins/install', typeof input === 'string' ? { text: input } : input);
    },
    /* 系统声音开关：控制当前正在发声的程序 */
    audioStatus() {
      if (state.mode === 'demo') return Promise.resolve({ ok: true, muted: false, playing: [], sessions: [], demo: true });
      return jsonFetch('/api/audio').catch(() => ({ ok: false, error: 'unreachable' }));
    },
    audioToggle() {
      requireLive('切换声音');
      return postJson('/api/audio/toggle', {});
    },
    /* 用户优化与功能投票 */
    getFeedback() {
      if (state.mode === 'demo') return Promise.resolve({ email: 'tianjinkang0130@sina.com', ideas: [], suggestions: [], mails: [], demo: true });
      return jsonFetch('/api/feedback').catch(() => ({ email: 'tianjinkang0130@sina.com', ideas: [], suggestions: [], mails: [] }));
    },
    voteIdea(id, delta) {
      requireLive('投票');
      return postJson('/api/feedback/vote', { id, delta });
    },
    addIdea(title, category) {
      requireLive('提交功能提案');
      return postJson('/api/feedback/idea', { title, category });
    },
    addSuggestion(payload) {
      requireLive('提交建议');
      return postJson('/api/feedback/suggest', payload);
    },
    deleteSuggestion(id) {
      requireLive('删除建议');
      return postJson('/api/feedback/suggest/remove', { id });
    },
    markFeedbackSent(payload) {
      requireLive('标记已发送');
      return postJson('/api/feedback/mark-sent', payload || {});
    },
    getMailto(subject) {
      requireLive('生成邮件');
      return jsonFetch('/api/feedback/mailto' + (subject ? '?subject=' + encodeURIComponent(subject) : ''));
    },
    sendFeedback(payload) {
      requireLive('发送反馈');
      return postJson('/api/feedback/send', payload || {});
    },

    /* 软件自更新 */
    checkUpdate(force) {
      requireLive('检查更新');
      return jsonFetch('/api/update/check' + (force ? '?force=1' : ''));
    },
    downloadUpdate(pkg) {
      requireLive('下载更新');
      return postJson('/api/update/download', { package: pkg });
    },
    updateProgress(jobId) {
      requireLive('查询下载进度');
      return jsonFetch('/api/update/progress?jobId=' + encodeURIComponent(jobId));
    },
    cancelUpdate(jobId) {
      return postJson('/api/update/cancel', { jobId }).catch(() => ({ ok: false }));
    }
  };

  window.NexusAPI = Object.assign({
    get mode() { return state.mode; },
    get health() { return state.health; },
    health, providers, detect, deepDetect, chat,
    getSettings: () => jsonFetch('/api/settings').catch(() => ({})),
    saveSettings: (patch) => postJson('/api/settings', patch).catch(() => ({})),
    getFlows: () => jsonFetch('/api/flows').catch(() => null),
    saveFlows: (payload) => postJson('/api/flows', payload).catch(() => null)
  }, admin);
})();
