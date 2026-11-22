'use strict';
/** 视图渲染层：纯函数式，只负责把 state 映射成 DOM */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const S = window.NexusState;

  const STATUS_TEXT = {
    online: '在线',
    offline: '离线',
    restricted: '受限',
    installed: '已安装',
    configured: '已配置'
  };
  const KIND_TEXT = {
    openai: 'HTTP', ollama: 'OLLAMA', app: 'APP', mcp: 'MCP', demo: 'DEMO', free: 'FREE'
  };
  const KIND_ICON = {
    openai: 'i-cloud', ollama: 'i-dot', app: 'i-app', mcp: 'i-tools', demo: 'i-spark', free: 'i-spark'
  };
  // 标注通过桥接发言的节点（自身不能直接推理），让 UI 明确「也能说话」
  function kindLabel(p) {
    if (p.id === 'free:pollinations') return '免费';
    if (!p.chatCapable && (p.kind === 'app' || p.kind === 'mcp')) return (KIND_TEXT[p.kind] || p.kind) + '·桥接';
    return KIND_TEXT[p.kind] || p.kind || 'AI';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function icon(name, cls = 'ico') {
    return `<svg class="${cls}"><use href="#${name}"/></svg>`;
  }

  let toastTimer = null;
  function toast(message, type = 'info') {
    const stack = $('#toasts');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'is-err' : type === 'ok' ? 'is-ok' : ''}`;
    el.innerHTML = `${icon(type === 'error' ? 'i-close' : type === 'ok' ? 'i-dot' : 'i-spark')}<span>${esc(message)}</span>`;
    stack.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 4200);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3600);
  }

  /* ------------------------------------------------------------ 顶栏状态 */

  function renderStatusStrip() {
    const { snapshot, mode } = S.state;
    const el = $('#statusStrip');
    if (!el) return;
    const s = (snapshot && snapshot.summary) || { online: 0, chatReady: 0, models: 0 };
    const demo = mode === 'demo' || (snapshot && snapshot.demo);
    el.innerHTML = [
      demo ? `<span class="pill is-demo">预览模式</span>` : `<span class="pill"><span class="dot"></span>本地服务已连接</span>`,
      `<span class="pill">在线 <b>${s.online || 0}</b></span>`,
      `<span class="pill">可对话 <b>${s.chatReady || 0}</b></span>`,
      `<span class="pill">模型 <b>${s.models || 0}</b></span>`
    ].join('');

    const sub = $('#sbSubText');
    const pulse = $('.pulse');
    if (sub) {
      sub.textContent = snapshot
        ? `${s.online} 个在线 · ${s.total} 个对象 · ${Math.round((snapshot.elapsedMs || 0))}ms`
        : '正在识别本机 AI…';
    }
    if (pulse) pulse.className = 'pulse' + (mode === 'demo' ? ' is-busy' : '');
  }

  /* -------------------------------------------------------------- 概览 */

  function renderHero() {
    const snap = S.state.snapshot;
    const el = $('#heroMetrics');
    if (!el) return;
    const s = (snap && snap.summary) || {};
    const items = [
      { label: 'ONLINE', value: s.online || 0, sub: '在线对象' },
      { label: 'CHAT', value: s.chatReady || 0, sub: '可对话通道' },
      { label: 'MODELS', value: s.models || 0, sub: '模型总数' },
      { label: 'SCAN', value: Math.round((snap && snap.elapsedMs) || 0), sub: '毫秒' }
    ];
    el.innerHTML = items.map((it) => `
      <div class="metric">
        <div class="metric-label">${it.label}</div>
        <div class="metric-value">${esc(it.value)}<small>${esc(it.sub)}</small></div>
      </div>`).join('');
  }

  function providerCard(p) {
    const caps = (p.caps || []).slice(0, 4).map((c, i) =>
      `<span class="cap ${i === 0 ? 'is-hot' : ''}">${esc(c)}</span>`).join('');
    const models = p.modelCount || (p.models ? p.models.length : 0);
    const latency = p.latencyMs ? `${p.latencyMs} ms` : '—';
    const modelLine = p.isTool
      ? (p.meta && p.meta.mcpServers && p.meta.mcpServers.length ? `工具 <b>${p.meta.mcpServers.length}</b>` : '工具服务')
      : `模型 <b>${models}</b>`;
    return `
      <article class="pcard${p.isTool ? ' is-tool' : ''}" data-status="${esc(p.status)}" data-provider="${esc(p.id)}">
        <div class="pcard-top">
          <div class="pcard-ico">${icon(KIND_ICON[p.kind] || 'i-cloud')}</div>
          <div class="pcard-title">
            <span class="pcard-name">${esc(p.name)}</span>
            <span class="pcard-vendor">${esc(p.vendor || '')} · ${esc(p.isTool ? (p.category === 'tool' ? 'MCP 工具' : '宿主应用') : (KIND_TEXT[p.kind] || p.kind))} · ${esc(STATUS_TEXT[p.status] || p.status)}</span>
          </div>
          <span class="status-dot" data-s="${esc(p.status)}"></span>
        </div>
        <p class="pcard-detail">${esc(p.detail || p.endpoint || '')}</p>
        <div class="pcard-caps">${caps}</div>
        <div class="pcard-foot">
          <span>${modelLine}</span>
          <span>握手 <b>${esc(latency)}</b></span>
        </div>
      </article>`;
  }

  function renderProviders() {
    const snap = S.state.snapshot;
    const grid = $('#providerGrid');
    const toolGrid = $('#toolGrid');
    const hint = $('#providerHint');
    const toolHint = $('#toolHint');
    if (!grid) return;
    const all = (snap && snap.providers) || [];
    const models = all.filter((p) => !p.isTool && p.category !== 'tool' && p.category !== 'app');
    const tools = all.filter((p) => p.isTool || p.category === 'tool' || p.category === 'app');

    if (!models.length) {
      grid.innerHTML = `<div class="pcard"><div class="pcard-detail">未发现任何 AI 模型。请确认本机 AI 已启动，或点击「全盘识别」扫描磁盘。</div></div>`;
    } else {
      grid.innerHTML = models.map(providerCard).join('');
    }
    if (hint) hint.textContent = `${models.length} 个模型/通道 · 生成于 ${new Date((snap && snap.generatedAt) || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })}`;

    if (toolGrid) {
      if (!tools.length) {
        toolGrid.innerHTML = `<div class="pcard is-tool"><div class="pcard-detail">未检测到 MCP 工具或宿主应用。它们不是模型，只是供 AI 调用的外部工具或运行容器。</div></div>`;
      } else {
        toolGrid.innerHTML = tools.map(providerCard).join('');
      }
      if (toolHint) toolHint.textContent = `${tools.length} 项 · 不计入模型总数`;
    }
  }

  function renderPipeline() {
    const el = $('#pipeline');
    if (!el) return;
    const steps = [
      { name: '端点扫描', desc: '并发握手 11434 / 1234 / 8080 / 8000 / 8326 等常见本地端口' },
      { name: '应用识别', desc: '读取 .dsh、Claude-Data 等安装痕迹，判定宿主应用是否存在' },
      { name: 'MCP 装载', desc: '解析 WorkBuddy / Claude Desktop 的 mcp.json，登记工具服务' },
      { name: '凭据复用', desc: '按需读取本机既有凭据，注册云端通道（不复制、不落盘）' },
      { name: '通道注册', desc: '归一化为统一 Provider 描述，写入画布节点可选的通道列表' }
    ];
    el.innerHTML = steps.map((s, i) => `
      <div class="pipe-step">
        <span class="pipe-state">DONE</span>
        <div class="pipe-index">0${i + 1}</div>
        <div class="pipe-name">${esc(s.name)}</div>
        <div class="pipe-desc">${esc(s.desc)}</div>
      </div>`).join('');
  }

  /* -------------------------------------------------------- 侧栏目标列表 */

  function renderTargets() {
    const list = $('#targetList');
    const count = $('#targetCount');
    if (!list) return;
    // 侧栏只列真正的模型通道；MCP 工具与宿主应用不是模型，不混进列表
    const providers = S.state.providers.filter((p) =>
      !p.isTool && p.category !== 'tool' && p.category !== 'app' &&
      p.kind !== 'mcp' && p.kind !== 'app' && p.chatCapable);
    if (count) count.textContent = String(providers.length);

    if (!providers.length) {
      list.innerHTML = `<div class="t-meta" style="padding:10px 9px">正在识别…</div>`;
      return;
    }

    const activeId = (S.currentTarget() || {}).id;
    const chatIds = S.state.targets;

    list.innerHTML = providers.map((p) => {
      // 所有节点都可对话：自身不能推理的会自动桥接到在线通道
      const bridged = !p.chatCapable;
      const sel = p.id === activeId;
      const meta = bridged
        ? '桥接发言 · 自动选在线模型'
        : `${p.modelCount || (p.models || []).length} 模型 · ${p.latencyMs || '—'}ms`;
      return `
        <button class="target-item ${sel ? 'is-sel' : ''}"
                data-target="${esc(p.id)}">
          <span class="t-dot" data-s="${esc(p.status)}"></span>
          <span class="t-body">
            <span class="t-name">${esc(p.name)}</span>
            <span class="t-meta">${esc(meta)}</span>
          </span>
          <span class="t-kind">${esc(kindLabel(p))}</span>
        </button>`;
    }).join('');
    void chatIds;
  }

  /* ---------------------------------------------------------------- 对话 */

  function renderChatHead() {
    const target = S.currentTarget();
    const el = $('#chatTarget');
    const modelEl = $('#chatModel');
    if (!el) return;
    const chips = S.chatReady().slice(0, 6).map((p) => `
      <button class="chip ${target && p.id === target.id ? 'is-on' : ''}" data-target="${esc(p.id)}">
        <span class="dot"></span>${esc(p.name)}
      </button>`).join('');
    el.innerHTML = `<button class="chip ${target ? '' : 'is-on'}" data-target="auto">自动路由</button>${chips}`;
    if (modelEl) {
      const model = target ? (S.state.models[target.id] || (target.models && target.models[0] && target.models[0].id) || '—') : '—';
      modelEl.textContent = target ? `${target.id} · ${model}` : '未选择通道';
    }
  }

  function renderChat() {
    const list = $('#msgList');
    const empty = $('#chatEmpty');
    if (!list) return;
    const messages = S.state.messages;
    if (empty) empty.hidden = messages.length > 0;

    const seen = new Set();
    for (const m of messages) {
      seen.add(m.id);
      let el = list.querySelector(`[data-mid="${m.id}"]`);
      if (!el) {
        el = document.createElement('div');
        if (m.role === 'system') {
          el.className = 'msg-sys' + (m.pluginOk === false ? ' is-err' : '');
          el.dataset.mid = m.id;
          el.textContent = m.content || '';
          list.appendChild(el);
        } else {
        el.className = 'msg' + (m.role === 'user' ? ' is-user' : '') + (m.error ? ' is-error' : '');
        el.dataset.mid = m.id;
        el.innerHTML = `
          <div class="msg-avatar">${m.role === 'user' ? '你' : 'AI'}</div>
          <div class="msg-body">
            <div class="msg-meta"><b>${esc(m.providerName || 'NEXUS')}</b><span>·</span><span class="m-model">${esc(m.model || '')}</span></div>
            <div class="think-block" hidden>
              <button class="think-head" type="button" data-think-toggle="${esc(m.id)}">
                <svg class="ico"><use href="#i-brain"/></svg>
                <span class="think-label">已深度思考</span>
                <span class="think-state"></span>
                <svg class="ico think-caret"><use href="#i-chevron"/></svg>
              </button>
              <div class="think-content"></div>
            </div>
            <div class="msg-bubble"></div>
            <div class="msg-hint" hidden></div>
            <div class="msg-actions" hidden></div>
          </div>`;
        list.appendChild(el);
        }
      }
      if (m.role === 'system') {
        if (el.textContent !== m.content) el.textContent = m.content;
        continue;
      }
      // 深度思考面板：有思考内容就显示，思考中自动展开并滚动到底
      const thinkBlock = el.querySelector('.think-block');
      if (thinkBlock) {
        const hasThink = !!(m.thinking && m.thinking.trim());
        thinkBlock.hidden = !hasThink;
        if (hasThink) {
          const content = thinkBlock.querySelector('.think-content');
          if (content.textContent !== m.thinking) content.textContent = m.thinking;
          const stateEl = thinkBlock.querySelector('.think-state');
          const labelEl = thinkBlock.querySelector('.think-label');
          const live = !!m.deepThinking;
          const label = m.thinkMs != null
            ? `已深度思考（用时 ${m.thinkMs} 秒）`
            : (live ? '正在深度思考…' : '已深度思考');
          if (labelEl.textContent !== label) labelEl.textContent = label;
          if (stateEl) stateEl.textContent = live ? '思考中' : '';
          thinkBlock.classList.toggle('is-live', live);
          thinkBlock.classList.toggle('is-collapsed', m.thinkOpen === false && !live);
          // 流式思考时跟随滚动
          if (live && content) content.scrollTop = content.scrollHeight;
        }
      }
      const bubble = el.querySelector('.msg-bubble');
      if (bubble.textContent !== m.content) bubble.textContent = m.content;
      bubble.classList.toggle('is-streaming', !!m.streaming);
      const hintEl = el.querySelector('.msg-hint');
      if (m.hint) { hintEl.hidden = false; hintEl.textContent = m.hint; } else { hintEl.hidden = true; }
      const actionsEl = el.querySelector('.msg-actions');
      if (actionsEl) {
        const showRepair = !!m.error && !m.streaming;
        actionsEl.hidden = !showRepair;
        const want = showRepair
          ? `<button class="msg-repair-btn" data-repair="1">${icon('i-spark')}一键修复并查看诊断</button>`
          : '';
        if (actionsEl.innerHTML !== want) actionsEl.innerHTML = want;
      }
      const modelEl = el.querySelector('.m-model');
      if (modelEl && m.model) modelEl.textContent = m.model;
      // 桥接标注：由哪个节点代答
      const metaEl = el.querySelector('.msg-meta');
      if (metaEl) {
        const old = metaEl.querySelector('.m-bridge');
        if (old) old.remove();
        const oldPick = metaEl.querySelector('.m-autopick');
        if (oldPick) oldPick.remove();
        if (m.bridge) {
          const note = document.createElement('span');
          note.className = 'm-bridge';
          note.textContent = `由 ${m.bridge.speakerName || '在线模型'} 代答`;
          note.title = m.bridge.reason || '该节点已自动桥接到在线通道';
          metaEl.appendChild(note);
        }
        if (m.modelChoice && m.modelChoice.reason) {
          const pick = document.createElement('span');
          pick.className = 'm-autopick';
          pick.textContent = `⚡ ${m.modelChoice.reason}`;
          pick.title = `智能选模型：${m.modelChoice.model}${m.modelChoice.complexity != null ? ` · 复杂度 ${m.modelChoice.complexity}` : ''}`;
          metaEl.appendChild(pick);
        }
      }
      el.classList.toggle('is-error', !!m.error);
    }

    // 移除已被清空的
    $$('.msg', list).forEach((el) => {
      if (!seen.has(el.dataset.mid)) el.remove();
    });

    const scroll = $('#chatScroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function renderEmptyChips() {
    const el = $('#emptyChips');
    if (!el) return;
    const presets = ['用一句话说明你现在能做什么', '把本机所有可用模型列出来', '帮我规划一个多 AI 协作流程'];
    el.innerHTML = presets.map((p) => `<button class="chip" data-preset="${esc(p)}">${esc(p)}</button>`).join('');
  }

  /* ------------------------------------------------------------ 通话对象 */

  function renderCallRoster() {
    const el = $('#callRoster');
    if (!el) return;
    const pool = S.chatReady();
    if (!pool.length) {
      el.innerHTML = `<span class="section-hint">暂无可用通道，请先启动本机 AI</span>`;
      return;
    }
    el.innerHTML = pool.map((p) => {
      const on = S.state.call.participants.includes(p.id);
      return `<button class="chip ${on ? 'is-on' : ''}" data-participant="${esc(p.id)}">
        <span class="dot"></span>${esc(p.name)}
      </button>`;
    }).join('');
  }

  window.NexusViews = {
    esc, icon, toast,
    renderStatusStrip, renderHero, renderProviders, renderPipeline,
    renderTargets, renderChatHead, renderChat, renderEmptyChips, renderCallRoster,
    STATUS_TEXT, KIND_TEXT
  };
})();
