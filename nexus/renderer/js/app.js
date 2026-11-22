'use strict';
/** 应用引导：路由、对话、通话通道、设置绑定 */
(function () {
  const S = window.NexusState;
  const API = window.NexusAPI;
  const V = window.NexusViews;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const VIEW_META = {
    overview: { crumb: '概览', sub: '本机 AI 拓扑' },
    chat: { crumb: '对话', sub: '单通道提问' },
    group: { crumb: 'AI 群聊', sub: '多人自动协作' },
    canvas: { crumb: '编排画布', sub: '多 AI 流程' },
    call: { crumb: '通话通道', sub: '多 AI 圆桌' },
    hub: { crumb: '模型接入', sub: 'API 与自愈修复' },
    feedback: { crumb: '用户优化', sub: '功能投票与建议' },
    settings: { crumb: '设置', sub: '识别与路由' }
  };

  let canvasFitted = false;

  /* 当前流式任务：对话用 AbortController，群聊/画布由各自模块管理。
   * 点「停止」时会同时调用本地中断与服务端 /api/*\/stop，双保险掐断输出与思考。 */
  let chatAbort = null;
  let chatRequestId = null;

  const HINTS = {
    insufficient_balance: '上游钱包余额不足，请到该服务控制台充值，或在侧栏切换到其他通道。',
    unauthorized: '本机保存的密钥失效了，请回到原应用重新登录。',
    missing_runtime: '该通道缺少本机运行时依赖，请按提示安装后重试。',
    rate_limited: '触发限流，稍后再试或换通道。',
    not_chat_capable: '应用 / MCP 节点不支持直接对话，请在画布中作为工具节点使用。',
    provider_missing: '通道已离线，点右上角「重新识别」刷新拓扑。',
    model_not_found: '模型或接口路径不存在，可在「模型接入」刷新模型清单，或点「一键修复」。',
    missing_runtime: '缺少 Bun / Python 等本机运行时，点「一键修复」可自动补齐已安装的运行时。',
    context_overflow: '对话超出上下文上限，清空会话或换长上下文模型。'
  };

  /* 报错后自动触发自愈的错误类型；90 秒内不重复，避免失败风暴 */
  const REPAIRABLE = new Set([
    'model_not_found', 'request_failed', 'upstream_error', 'missing_runtime',
    'unauthorized', 'provider_missing', 'insufficient_balance'
  ]);
  let lastAutoRepair = 0;

  /* ───────────────────────── 路由 ───────────────────────── */

  function go(view) {
    if (!VIEW_META[view]) return;
    S.set({ view }, true);
    if (location.hash !== '#' + view) {
      try { history.replaceState(null, '', '#' + view); } catch { /* ignore */ }
    }
    $$('.view').forEach((el) => el.classList.toggle('is-active', el.dataset.view === view));
    $$('.rail-btn').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.view === view));
    $('#crumb').textContent = VIEW_META[view].crumb;
    $('#crumbSub').textContent = VIEW_META[view].sub;

    const palette = $('[data-block="palette"]');
    if (palette) palette.hidden = view !== 'canvas';
    const targetsBlock = $('[data-block="targets"]');
    if (targetsBlock) targetsBlock.hidden = view === 'canvas' || view === 'settings' || view === 'group';

    const label = $('#composerLabel');
    const mode = $('#composerMode');
    if (view === 'canvas') {
      label.textContent = '流程输入 · 作为 {{input}}';
      mode.textContent = 'FLOW';
    } else if (view === 'call') {
      label.textContent = '通话开场白 · Enter 开始';
      mode.textContent = 'CALL';
    } else if (view === 'group') {
      label.textContent = '群聊发言 · 自动分配';
      mode.textContent = 'GROUP';
    } else {
      label.textContent = '提问 · 自动路由';
      mode.textContent = 'AUTO';
    }

    if (view === 'canvas') {
      window.NexusCanvas.init().then(() => {
        window.NexusCanvas.refresh();
        if (!canvasFitted) { canvasFitted = true; window.NexusCanvas.fit(); }
      });
    }
    if (view === 'chat') { V.renderChatHead(); V.renderChat(); }
    if (view === 'call') { V.renderCallRoster(); }
    if (view === 'group' && window.NexusGroup) window.NexusGroup.onShow();
    if (view === 'hub' && window.NexusHub) window.NexusHub.onShow();
    if (view === 'feedback' && window.NexusFeedback) {
      if (window.NexusFeedback.setToast) window.NexusFeedback.setToast((msg, kind) => V.toast(msg, kind));
      window.NexusFeedback.onShow();
    }
    if (view === 'settings') {
      if (window.NexusSound) window.NexusSound.onShow();
      if (window.NexusFeedback && window.NexusFeedback.setToast) window.NexusFeedback.setToast((msg, kind) => V.toast(msg, kind));
      loadSmtpSettings();
    }
  }

  /* ───────────────────────── 快照 ───────────────────────── */

  function applySnapshot(snap) {
    if (!snap) return;
    const providers = snap.providers || [];
    const models = {};
    for (const p of providers) {
      if (p.models && p.models.length) models[p.id] = p.models[0].id;
    }
    const chat = providers.filter((p) => p.chatCapable && p.status === 'online');
    const targets = chat.slice(0, 3).map((p) => p.id);
    const keepActive = S.state.activeProviderId && providers.some((p) => p.id === S.state.activeProviderId && p.chatCapable);

    S.set({
      snapshot: snap,
      providers,
      models,
      targets,
      activeProviderId: keepActive ? S.state.activeProviderId : null
    });

    S.state.call.participants = S.state.call.participants.filter((id) => chat.some((p) => p.id === id));
    if (!S.state.call.participants.length) S.state.call.participants = chat.slice(0, 3).map((p) => p.id);

    V.renderStatusStrip();
    V.renderHero();
    V.renderProviders();
    V.renderPipeline();
    V.renderTargets();
    V.renderChatHead();
    V.renderCallRoster();
    window.NexusCanvas.refresh();
  }

  async function rescan(manual) {
    const btns = [$('#detectBtn'), $('#railDetect')].filter(Boolean);
    btns.forEach((b) => b.classList.add('is-busy'));
    try {
      const snap = manual ? await API.detect() : await API.providers(true);
      applySnapshot(snap);
      V.toast(`识别完成：${snap.summary.online} 个在线 / ${snap.summary.total} 个对象`, 'ok');
    } catch (err) {
      V.toast(`识别失败：${err.message}`, 'error');
    } finally {
      btns.forEach((b) => b.classList.remove('is-busy'));
    }
  }

  /* ───────────────────────── 对话 ───────────────────────── */

  /**
   * 对话失败时的自动自愈：后台跑一次诊断 + 可回滚修复，
   * 不自动重发消息（避免失败循环），只把结果写进该条回复的提示里。
   */
  function maybeAutoRepair(err, reply) {
    const settings = S.state.settings || {};
    if (settings.autoRepairOnError === false) return;
    if (!window.NexusHub || typeof window.NexusHub.runRepair !== 'function') return;
    if (!REPAIRABLE.has(err && err.code)) return;
    const now = Date.now();
    if (now - lastAutoRepair < 90000) return;
    lastAutoRepair = now;

    const base = reply.hint || '';
    reply.hint = base + (base ? ' ｜ ' : '') + '正在后台自动诊断与修复…';
    V.renderChat();

    window.NexusHub.runRepair(true, { silent: true }).then((report) => {
      let note;
      if (!report || report.ok === false) note = '自动诊断失败，请到「模型接入」页手动点「一键修复」。';
      else if (report.fixedCount) note = `已自动修复 ${report.fixedCount} 项，请重新发送`;
      else if (report.manualCount) note = `诊断发现 ${report.manualCount} 项需手动处理`;
      else note = '自动体检未发现可修复问题，建议换一条通道重试';
      if (report && report.needRestart) note += '（部分改动需重启 DeepSeek Harness）';
      reply.hint = (base ? base + ' ｜ ' : '') + note + ' · 详情见「模型接入」页';
      V.renderChat();
    }).catch(() => {
      reply.hint = (base ? base + ' ｜ ' : '') + '自动诊断未完成，可点下方「一键修复」';
      V.renderChat();
    });
  }

  let flushing = false;
  function scheduleChatRender() {
    if (flushing) return;
    flushing = true;
    requestAnimationFrame(() => { flushing = false; V.renderChat(); });
  }

  async function send(text) {
    const content = (text == null ? $('#promptInput').value : text).trim();
    if (!content) return;
    if (S.state.busy) { V.toast('上一条还在回复中', 'error'); return; }

    if (S.state.view === 'call') { startCall(content); return; }
    if (S.state.view === 'group') {
      if (window.NexusGroup) window.NexusGroup.send(content);
      return;
    }
    if (S.state.view === 'canvas') { $('#promptInput').value = content; window.NexusCanvas.run(); return; }

    const target = S.currentTarget();
    if (!target) {
      V.toast('没有可用通道，先在概览里确认本机 AI 是否启动', 'error');
      return;
    }
    // 自身不能推理的节点（应用 / MCP / 离线端点）由服务端自动桥接到在线通道，无需拦截。

    const history = S.history();
    const model = S.state.models[target.id] || (target.models && target.models[0] && target.models[0].id);

    const userMsg = { id: uid('m'), role: 'user', content, providerName: '你', model: '' };
    const reply = {
      id: uid('m'), role: 'assistant', content: '', providerName: target.name,
      model: model || '', streaming: true,
      // 深度思考：thinking 累积思考文本，deepThinking 表示当前正在思考
      thinking: '', deepThinking: false, thinkOpen: true,
      thinkStartedAt: Date.now()
    };

    const ctrl = new AbortController();
    let stopped = false;
    chatAbort = ctrl;
    chatRequestId = null;
    updateStopButton();

    S.set({ messages: S.state.messages.concat([userMsg, reply]), busy: true });
    if (S.state.view !== 'chat') go('chat');
    V.renderChat();
    $('#promptInput').value = '';
    autoGrow();

    try {
      const res = await API.chat({
        providerId: target.id,
        model,
        messages: history.concat([{ role: 'user', content }]),
        // 省额度：自动路由下限制单次输出长度；手动选中的通道不受影响
        maxTokens: S.state.activeProviderId ? undefined : 768,
        // 深度思考：输入框开启时强制 true；关闭时传 null，交给设置页的本地思考链开关决定
        think: (S.state.settings && S.state.settings.deepThink) === true ? true : null,
        signal: ctrl.signal,
        onRequestId: (id) => { chatRequestId = id; },
        onStopped: () => { stopped = true; },
        onMeta: (m) => {
          if (m && m.bridge) {
            reply.bridge = m.bridge;
            reply.providerName = m.bridge.requestedName;
          }
          if (m && m.modelChoice) {
            reply.modelChoice = m.modelChoice;
            reply.model = m.model || reply.model;
          }
          if (m && typeof m.think === 'boolean') reply.deepThinkEnabled = m.think;
        },
        onPlugin: (p) => {
          if (!p) return;
          const sys = { id: uid('sys'), role: 'system', content: p.message || '插件操作完成', system: true, pluginOk: !!p.ok };
          S.set({ messages: S.state.messages.concat([sys]) });
          if (p.needRescan) rescan(false);
          scheduleChatRender();
        },
        onDelta: (t) => {
          if (stopped || ctrl.signal.aborted) return;
          reply.content += t;
          if (reply.hint) reply.hint = '';
          scheduleChatRender();
        },
        onThinking: (t) => {
          if (stopped || ctrl.signal.aborted) return;
          if (t) {
            reply.thinking = (reply.thinking || '') + t;
            reply.deepThinking = true;
            reply.hint = '';
          }
          scheduleChatRender();
        },
        onError: (e) => {
          if (stopped || ctrl.signal.aborted) return;
          reply.error = true;
          reply.hint = e.hint || HINTS[e.code] || '';
          if (!reply.content) reply.content = `调用失败：${e.message}`;
        }
      });
      reply.streaming = false;
      reply.deepThinking = false;
      // 有些兼容接口只在 done 里一次性回传思维链，这里补全
      if (res && res.reasoning && !reply.thinking) reply.thinking = res.reasoning;
      reply.thinkMs = Math.max(1, Math.round((Date.now() - (reply.thinkStartedAt || Date.now())) / 100) / 10);
      if (stopped || ctrl.signal.aborted) {
        reply.stopped = true;
        reply.hint = reply.content ? '已停止输出' : '已停止思考';
      } else {
        if (!reply.content && res && res.text) reply.content = res.text;
        if (!reply.content) { reply.error = true; reply.content = '上游返回了空响应。'; }
      }
    } catch (err) {
      reply.streaming = false;
      reply.deepThinking = false;
      if (stopped || ctrl.signal.aborted || (err && (err.name === 'AbortError' || err.code === 'aborted'))) {
        reply.stopped = true;
        reply.hint = reply.content ? '已停止输出' : '已停止思考';
      } else {
        reply.error = true;
        reply.code = err.code || '';
        reply.hint = err.hint || HINTS[err.code] || '';
        if (!reply.content) reply.content = `调用失败：${err.message}`;
        maybeAutoRepair(err, reply);
      }
    } finally {
      if (chatAbort === ctrl) { chatAbort = null; chatRequestId = null; }
      S.set({ busy: false });
      updateStopButton();
      V.renderChat();
    }
  }

  /* ───────────────────────── 通话通道 ───────────────────────── */

  const call = { stop: false, running: false, level: 0, raf: 0 };

  function anyRunning() {
    return !!(chatAbort || call.running ||
      (window.NexusGroup && window.NexusGroup.isRunning && window.NexusGroup.isRunning()) ||
      (window.NexusCanvas && window.NexusCanvas.isRunning && window.NexusCanvas.isRunning()));
  }

  /** 深度思考开关：输入框 chip 与设置页 checkbox 双向同步并落盘 */
  function applyDeepThinkUI(on) {
    const btn = $('#deepThinkBtn');
    if (btn) {
      btn.classList.toggle('is-on', !!on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if ($('#setDeepThink')) $('#setDeepThink').checked = !!on;
  }

  function toggleDeepThink(force) {
    const cur = !!(S.state.settings && S.state.settings.deepThink);
    const next = typeof force === 'boolean' ? force : !cur;
    S.set({ settings: Object.assign({}, S.state.settings, { deepThink: next }) }, true);
    applyDeepThinkUI(next);
    API.saveSettings({ deepThink: next }).catch(() => {});
    V.toast(next ? '已开启深度思考 · 下次提问将展示思考过程' : '已关闭深度思考', 'ok');
  }

  /** 生成中把「发送」换成「停止」，任何视图都可一键掐断 */
  function updateStopButton() {
    const stopBtn = $('#stopBtn');
    const sendBtn = $('#sendBtn');
    const running = anyRunning();
    if (stopBtn) stopBtn.hidden = !running;
    if (sendBtn) sendBtn.hidden = running;
    const hint = $('#composerHint');
    if (hint) hint.textContent = running ? '生成中 · 可随时停止' : '';
  }

  /** 停止当前正在输出的任务（含思考链） */
  function stopActive() {
    if (call.running) { stopCall(); return; }
    if (window.NexusGroup && window.NexusGroup.isRunning && window.NexusGroup.isRunning()) {
      window.NexusGroup.stop();
      updateStopButton();
      return;
    }
    if (window.NexusCanvas && window.NexusCanvas.isRunning && window.NexusCanvas.isRunning()) {
      window.NexusCanvas.stop();
      updateStopButton();
      return;
    }
    if (chatAbort) {
      const id = chatRequestId;
      if (id) API.stopChat(id).catch(() => {});
      chatAbort.abort();
      const last = [...S.state.messages].reverse().find((m) => m.role === 'assistant' && m.streaming);
      if (last) {
        last.streaming = false;
        last.stopped = true;
        last.hint = last.content ? '已停止输出' : '已停止思考';
        V.renderChat();
      }
      updateStopButton();
    }
  }

  function setCallStatus(text, live) {
    const el = $('#callStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-live', !!live);
  }

  function addTranscript(who, text, kind) {
    const box = $('#callTranscript');
    if (!box) return null;
    const el = document.createElement('div');
    el.className = `ct-item ${kind === 'user' ? 'is-user' : ''}`;
    el.innerHTML = `<span class="ct-who">${V.esc(who)}</span><span class="ct-text"></span>`;
    el.querySelector('.ct-text').textContent = text || '';
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  function speak(text) {
    if (!$('#callSpeak').checked) return;
    if (!window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 400));
      u.lang = 'zh-CN';
      u.rate = 1.02;
      u.onstart = () => { call.level = 1; };
      u.onend = () => { call.level = 0.15; };
      window.speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }

  async function speakOne(providerId, round, prompt, context) {
    if (call.stop) return;
    const provider = S.providerById(providerId);
    if (!provider) return;
    const item = addTranscript(provider.name, '…', 'ai');
    const textEl = item.querySelector('.ct-text');
    item.classList.add('is-speaking');
    call.level = 0.6;

    const model = S.state.models[providerId] || (provider.models && provider.models[0] && provider.models[0].id);
    const messages = [
      { role: 'system', content: '你正在一个多 AI 圆桌通话中。请用不超过 80 字的口语化中文回应，不要使用列表和标题。' },
      { role: 'user', content: `第 ${round} 轮。用户说：${prompt}\n${context ? '此前发言：' + context.slice(-400) : ''}` }
    ];

    let acc = '';
    try {
      await API.chat({
        providerId,
        model,
        messages,
        onDelta: (t) => {
          acc += t;
          textEl.textContent = acc;
          const box = $('#callTranscript');
          if (box) box.scrollTop = box.scrollHeight;
          call.level = 0.55 + Math.random() * 0.45;
        },
        onError: (e) => {
          acc = acc || `（${provider.name} 未能发言：${e.message}）`;
          item.classList.add('is-user');
        }
      });
      if (!acc) acc = '（无内容）';
      textEl.textContent = acc;
      speak(acc);
      await new Promise((r) => setTimeout(r, 380));
    } catch (err) {
      textEl.textContent = `（${provider.name} 未能发言：${err.message}）`;
    } finally {
      item.classList.remove('is-speaking');
      call.level = 0.15;
    }
    return acc;
  }

  async function startCall(text) {
    if (call.running) { V.toast('通话进行中', 'error'); return; }
    const ids = S.state.call.participants;
    if (!ids.length) { V.toast('先在上方选至少一个参与者', 'error'); return; }

    const prompt = (text || '').trim() || '请用一句话说明你能为这次协作贡献什么，并给一个具体建议。';
    call.running = true;
    call.stop = false;
    $('#callStart').disabled = true;
    $('#callStop').disabled = false;
    updateStopButton();
    setCallStatus('通话中', true);
    $('#callTranscript').innerHTML = '';
    addTranscript('你', prompt, 'user');

    const rounds = Math.max(1, Math.min(6, Number($('#callRounds').value) || 2));
    const mode = $('#callMode').value;
    let context = '';

    try {
      for (let r = 1; r <= rounds && !call.stop; r++) {
        setCallStatus(`第 ${r}/${rounds} 轮`, true);
        if (mode === 'parallel') {
          const results = await Promise.all(ids.map((id) => speakOne(id, r, prompt, context)));
          context += '\n' + results.filter(Boolean).join('\n');
        } else {
          for (const id of ids) {
            if (call.stop) break;
            const out = await speakOne(id, r, prompt, context);
            if (out) context += '\n' + out;
          }
        }
      }
      setCallStatus(call.stop ? '已挂断' : '通话结束', false);
    } finally {
      call.running = false;
      call.level = 0.15;
      $('#callStart').disabled = false;
      $('#callStop').disabled = true;
      updateStopButton();
    }
  }

  function stopCall() {
    call.stop = true;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setCallStatus('已挂断', false);
    $('#callStop').disabled = true;
    $('#callStart').disabled = false;
    call.running = false;
    updateStopButton();
  }

  /* 波形：装饰性可视化，语音播放时振幅抬高 */
  function startWave() {
    const canvas = $('#waveCanvas');
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    let t = 0;

    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, r.width * dpr);
      canvas.height = Math.max(1, r.height * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    function draw() {
      const r = canvas.getBoundingClientRect();
      const w = r.width;
      const h = r.height;
      ctx2d.clearRect(0, 0, w, h);
      if (w < 4 || h < 4) { call.raf = requestAnimationFrame(draw); return; }

      const bars = Math.floor(w / 9);
      const mid = h * 0.5;
      const base = call.running ? 0.35 : 0.08;
      const amp = mid * (base + call.level * 0.5);

      for (let i = 0; i < bars; i++) {
        const x = i * 9 + 4;
        const p = i / bars;
        const wave =
          Math.sin(t * 0.05 + p * 9) * 0.5 +
          Math.sin(t * 0.027 + p * 4.3) * 0.35 +
          Math.sin(t * 0.11 + p * 17) * 0.15;
        const hh = Math.max(2, Math.abs(wave) * amp);
        const grad = ctx2d.createLinearGradient(0, mid - hh, 0, mid + hh);
        grad.addColorStop(0, 'rgba(123,92,255,0.85)');
        grad.addColorStop(0.5, 'rgba(91,140,255,0.7)');
        grad.addColorStop(1, 'rgba(34,211,238,0.85)');
        ctx2d.fillStyle = grad;
        ctx2d.globalAlpha = 0.9;
        const rw = 1.8;
        ctx2d.beginPath();
        const rr = Math.min(rw, 2);
        ctx2d.roundRect(x, mid - hh, rw, hh * 2, rr);
        ctx2d.fill();
      }
      ctx2d.globalAlpha = 1;
      t += 1;
      call.raf = requestAnimationFrame(draw);
    }
    cancelAnimationFrame(call.raf);
    draw();
  }

  /* ───────────────────────── 输入框 ───────────────────────── */

  function autoGrow() {
    const el = $('#promptInput');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(132, el.scrollHeight) + 'px';
  }

  function bindComposer() {
    const input = $('#promptInput');
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    $('#sendBtn').addEventListener('click', () => {
      if (S.state.busy) { V.toast('还在回复中'); return; }
      send();
    });
    if ($('#stopBtn')) $('#stopBtn').addEventListener('click', stopActive);
    if ($('#deepThinkBtn')) $('#deepThinkBtn').addEventListener('click', () => toggleDeepThink());
    $('#clearBtn').addEventListener('click', () => {
      S.set({ messages: [] });
      V.renderChat();
      $('#chatFoot').textContent = '';
    });

    let recog = null;
    $('#micBtn').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { V.toast('当前环境不支持语音识别，可直接输入文字', 'error'); return; }
      if (recog) { recog.stop(); recog = null; btn.classList.remove('is-rec'); return; }
      recog = new SR();
      recog.lang = 'zh-CN';
      recog.interimResults = true;
      recog.continuous = false;
      btn.classList.add('is-rec');
      recog.onresult = (ev) => {
        let text = '';
        for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
        input.value = text;
        autoGrow();
      };
      recog.onend = () => { btn.classList.remove('is-rec'); recog = null; };
      recog.onerror = () => { btn.classList.remove('is-rec'); recog = null; V.toast('语音识别失败', 'error'); };
      recog.start();
    });
  }

  /* ───────────────────────── 软件更新 ───────────────────────── */

  const updateUI = {
    checking: false,
    jobId: null,
    pollTimer: null,
    result: null,
    installedPath: null
  };

  function el(id) { return document.getElementById(id); }

  function setUpdateState(text) {
    const node = el('updateState');
    if (node) node.textContent = text;
  }

  function setReleaseNote(text, isError) {
    const node = el('updateNote');
    if (!node) return;
    node.hidden = !text;
    node.textContent = text || '';
    node.classList.toggle('is-error', !!isError);
  }

  /** 检查官网是否有新版本。force=true 时忽略 10 分钟缓存。 */
  async function checkUpdate(force) {
    if (updateUI.checking) return;
    const btn = el('checkUpdateBtn');
    updateUI.checking = true;
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    setUpdateState('正在连接官网检查版本…');
    setReleaseNote('', false);
    try {
      const r = await API.checkUpdate(!!force);
      if (r.offLine || r.error) {
        setUpdateState('暂时无法连接更新服务器');
        setReleaseNote(r.error || '请检查网络后重试；也可以直接到官网下载最新版本。', true);
        return;
      }
      updateUI.result = r;
      if (r.available) {
        setUpdateState(`发现新版本 v${r.latest} · 当前 v${r.current}`);
        const box = el('updateLatest');
        if (box) box.hidden = false;
        const lv = el('latestVersion');
        if (lv) lv.textContent = `v${r.latest}`;
        const ld = el('latestDate');
        if (ld) ld.textContent = r.releasedAt ? new Date(r.releasedAt).toLocaleDateString('zh-CN') : '';
        const notes = el('releaseNotes');
        if (notes) notes.innerHTML = (r.notes || []).map((n) => `<li>${String(n).replace(/[<>]/g, '')}</li>`).join('');
        const dl = el('downloadUpdateBtn');
        if (dl) { dl.disabled = false; dl.textContent = '下载并安装'; }
        if (!r.package) {
          if (dl) dl.disabled = true;
          setReleaseNote('当前平台暂无对应安装包，请到官网手动下载。', true);
        }
      } else {
        setUpdateState(`已是最新版本 v${r.current}`);
        const box = el('updateLatest');
        if (box) box.hidden = true;
        if (!force) V.toast('已是最新版本', 'ok');
      }
    } catch (err) {
      setUpdateState('检查失败');
      setReleaseNote(err && err.message ? err.message : '检查更新失败，请稍后重试', true);
    } finally {
      updateUI.checking = false;
      if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
    }
  }

  /** 下载安装包：服务端流式落盘 + SHA256 校验，前端只轮询进度 */
  async function downloadUpdate() {
    const pkg = updateUI.result && updateUI.result.package;
    if (!pkg) { V.toast('没有可用的安装包', 'error'); return; }
    const dl = el('downloadUpdateBtn');
    const cancelBtn = el('cancelUpdateBtn');
    const progress = el('updateProgress');
    const openBtn = el('openInstallerBtn');
    if (dl) { dl.disabled = true; dl.textContent = '下载中…'; }
    if (cancelBtn) cancelBtn.hidden = false;
    if (openBtn) openBtn.hidden = true;
    if (progress) progress.hidden = false;
    setReleaseNote('', false);
    setUpdateState('正在下载安装包…');
    try {
      const started = await API.downloadUpdate(pkg);
      updateUI.jobId = started.jobId;
      pollDownload();
    } catch (err) {
      if (dl) { dl.disabled = false; dl.textContent = '重试下载'; }
      setReleaseNote(err && err.message ? err.message : '无法开始下载', true);
    }
  }

  function pollDownload() {
    if (updateUI.pollTimer) clearInterval(updateUI.pollTimer);
    updateUI.pollTimer = setInterval(async () => {
      if (!updateUI.jobId) return;
      let job;
      try { job = await API.updateProgress(updateUI.jobId); }
      catch { return; }
      const fill = el('upBarFill');
      const text = el('upText');
      if (job.state === 'downloading') {
        if (fill) fill.style.width = (job.percent || 0) + '%';
        if (text) {
          const got = (job.received / 1048576).toFixed(1);
          const total = job.total ? (job.total / 1048576).toFixed(1) : '?';
          text.textContent = `下载中 ${job.percent || 0}% · ${got} / ${total} MB`;
        }
        return;
      }
      clearInterval(updateUI.pollTimer);
      updateUI.pollTimer = null;
      const dl = el('downloadUpdateBtn');
      const cancelBtn = el('cancelUpdateBtn');
      const openBtn = el('openInstallerBtn');
      if (cancelBtn) cancelBtn.hidden = true;
      if (job.state === 'done') {
        if (fill) fill.style.width = '100%';
        if (text) text.textContent = '下载完成，已通过 SHA256 校验';
        setUpdateState('安装包已就绪');
        updateUI.installedPath = job.path;
        if (dl) { dl.disabled = false; dl.textContent = '重新下载'; }
        if (openBtn) openBtn.hidden = false;
        setReleaseNote('校验通过。点「打开安装包」后，按系统提示完成安装；安装完成后重启 NEXUS 即为新版本。安装过程不会改动你的数据目录。', false);
      } else if (job.state === 'cancelled') {
        if (text) text.textContent = '已取消下载';
        setUpdateState('已取消下载');
        if (dl) { dl.disabled = false; dl.textContent = '重新下载'; }
      } else {
        if (text) text.textContent = job.error || '下载失败';
        setUpdateState('下载失败');
        if (dl) { dl.disabled = false; dl.textContent = '重试下载'; }
        setReleaseNote(job.error || '下载失败，请重试或到官网手动下载。', true);
      }
    }, 450);
  }

  /** 打开已下载的安装包；只把路径交给主进程做白名单校验，绝不让页面任意执行文件 */
  async function openInstaller() {
    const pathValue = updateUI.installedPath;
    if (!pathValue) { V.toast('安装包尚未下载完成', 'error'); return; }
    if (!window.nexusHost || !window.nexusHost.openInstaller) {
      V.toast('当前是浏览器预览模式，无法打开本地安装包', 'error');
      return;
    }
    try {
      const r = await window.nexusHost.openInstaller(pathValue);
      if (r && r.ok) V.toast('已打开安装包，请按系统提示完成安装', 'ok');
      else V.toast((r && r.message) || '打开失败', 'error');
    } catch (err) {
      V.toast(err && err.message ? err.message : '打开失败', 'error');
    }
  }

  function bindUpdate() {
    const check = el('checkUpdateBtn');
    const dl = el('downloadUpdateBtn');
    const open = el('openInstallerBtn');
    const cancel = el('cancelUpdateBtn');
    if (check) check.addEventListener('click', () => checkUpdate(true));
    if (dl) dl.addEventListener('click', downloadUpdate);
    if (open) open.addEventListener('click', openInstaller);
    if (cancel) cancel.addEventListener('click', async () => {
      if (updateUI.jobId) await API.cancelUpdate(updateUI.jobId);
    });
  }

  /* ───────────────────────── 全局事件 ───────────────────────── */

  function bindGlobal() {
    $$('.rail-btn[data-view]').forEach((btn) => btn.addEventListener('click', () => go(btn.dataset.view)));
    $('#detectBtn').addEventListener('click', () => rescan(true));
    $('#railDetect').addEventListener('click', () => rescan(true));
    if ($('#langBtn')) $('#langBtn').addEventListener('click', () => {
      window.NexusI18n.setLang(window.NexusI18n.getLang() === 'en' ? 'zh' : 'en');
    });
    if ($('#setLanguage')) $('#setLanguage').addEventListener('change', (e) => {
      window.NexusI18n.setLang(e.target.value);
    });
    if ($('#smtpSaveBtn')) $('#smtpSaveBtn').addEventListener('click', () => saveSmtpSettings());

    // 错误消息里的「一键修复」
    document.addEventListener('click', (e) => {
      const repair = e.target.closest('[data-repair]');
      if (repair) {
        go('hub');
        if (window.NexusHub) window.NexusHub.runRepair(true);
        return;
      }
      const thinkToggle = e.target.closest('[data-think-toggle]');
      if (thinkToggle) {
        const mid = thinkToggle.dataset.thinkToggle;
        const msg = S.state.messages.find((m) => m.id === mid);
        if (msg) { msg.thinkOpen = msg.thinkOpen === false; V.renderChat(); }
        return;
      }
    });

    // 侧栏 / 对话头的通道选择
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-target]');
      if (t) {
        const id = t.dataset.target;
        if (id === 'auto') {
          S.set({ activeProviderId: null });
        } else {
          const p = S.providerById(id);
          if (!p) return;
          if (!p.chatCapable) { V.toast('该对象不支持直接对话', 'error'); return; }
          S.set({ activeProviderId: id, targets: Array.from(new Set(S.state.targets.concat([id]))) });
        }
        V.renderTargets();
        V.renderChatHead();
        if (S.state.view !== 'chat') go('chat');
        return;
      }

      const preset = e.target.closest('[data-preset]');
      if (preset) { send(preset.dataset.preset); return; }

      const participant = e.target.closest('[data-participant]');
      if (participant) {
        const id = participant.dataset.participant;
        const list = S.state.call.participants.slice();
        const i = list.indexOf(id);
        if (i >= 0) list.splice(i, 1); else list.push(id);
        S.state.call.participants = list;
        V.renderCallRoster();
        return;
      }
    });

    // 画布工具
    document.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) {
        const type = add.dataset.add;
        const body = $('#canvasBody');
        const r = body.getBoundingClientRect();
        window.NexusCanvas.addNode(type, (r.width / 2 - 104) / 1, (r.height / 2 - 60) / 1);
        return;
      }
    });
    $('#zoomIn').addEventListener('click', () => window.NexusCanvas.zoom(1.15));
    $('#zoomOut').addEventListener('click', () => window.NexusCanvas.zoom(1 / 1.15));
    $('#fitView').addEventListener('click', () => window.NexusCanvas.fit());
    $('#runFlow').addEventListener('click', () => window.NexusCanvas.run());
    $('#clearFlow').addEventListener('click', () => window.NexusCanvas.clear());

    // 通话
    $('#callStart').addEventListener('click', () => startCall());
    $('#callStop').addEventListener('click', stopCall);

    // 设置
    const persistSettings = () => {
      API.saveSettings({
        autoDetectOnStart: $('#setAutoDetect').checked,
        scanTimeoutMs: Number($('#setTimeout').value) || 1600,
        routing: $('#setRouting').value,
        autoRepairOnError: $('#setAutoRepair').checked,
        freeFallback: $('#setFreeFallback').checked,
        localModelPolicy: $('#setLocalPolicy') ? $('#setLocalPolicy').value : 'auto',
        pinnedLocalModel: $('#setPinnedModel') ? $('#setPinnedModel').value.trim() : null,
        // 界面上是「关闭思考链」，配置键 ollamaThink 语义相反
        ollamaThink: $('#setOllamaThink') ? !$('#setOllamaThink').checked : false,
        deepThink: $('#setDeepThink') ? $('#setDeepThink').checked : !!(S.state.settings && S.state.settings.deepThink),
        ollamaNumCtx: $('#setOllamaNumCtx') ? (Number($('#setOllamaNumCtx').value) || 4096) : 4096
      }).then((saved) => {
        if (saved) {
          S.set({ settings: Object.assign({}, S.state.settings, { deepThink: saved.deepThink === true, ollamaThink: saved.ollamaThink === true }) }, true);
          applyDeepThinkUI(saved.deepThink === true);
        }
        rescan(false);
      });
    };
    ['#setAutoDetect', '#setTimeout', '#setRouting', '#setAutoRepair', '#setFreeFallback',
      '#setLocalPolicy', '#setPinnedModel', '#setOllamaThink', '#setOllamaNumCtx',
      '#setDeepThink'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('change', persistSettings);
    });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        $('#promptInput').focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      }
      if (e.key === 'Escape' && anyRunning()) {
        e.preventDefault();
        stopActive();
      }
    });
  }

  async function loadSettings() {
    const s = await API.getSettings();
    if (!s) return;
    S.set({ settings: s }, true);
    if ($('#setAutoDetect')) $('#setAutoDetect').checked = s.autoDetectOnStart !== false;
    if ($('#setTimeout')) $('#setTimeout').value = s.scanTimeoutMs || 1600;
    if ($('#setRouting')) $('#setRouting').value = s.routing || 'auto';
    if ($('#setAutoRepair')) $('#setAutoRepair').checked = s.autoRepairOnError !== false;
    if ($('#setFreeFallback')) $('#setFreeFallback').checked = s.freeFallback !== false;
    if ($('#setLocalPolicy')) $('#setLocalPolicy').value = s.localModelPolicy || 'auto';
    if ($('#setPinnedModel')) $('#setPinnedModel').value = s.pinnedLocalModel || '';
    if ($('#setOllamaThink')) $('#setOllamaThink').checked = s.ollamaThink !== true;
    if ($('#setDeepThink')) $('#setDeepThink').checked = s.deepThink === true;
    if ($('#setOllamaNumCtx')) $('#setOllamaNumCtx').value = s.ollamaNumCtx || 4096;
    if (s.language && window.NexusI18n && window.NexusI18n.getLang() !== s.language) {
      window.NexusI18n.setLang(s.language, false);
    }
    applyDeepThinkUI(s.deepThink === true);
    if (s.speakOnCall === false && $('#callSpeak')) $('#callSpeak').checked = false;
    if (s.smtp) {
      if ($('#smtpHost')) $('#smtpHost').value = s.smtp.host || '';
      if ($('#smtpPort')) $('#smtpPort').value = s.smtp.port || 465;
      if ($('#smtpUser')) $('#smtpUser').value = s.smtp.user || '';
      if ($('#smtpPass')) $('#smtpPass').value = s.smtp.pass || '';
      if ($('#smtpSecure')) $('#smtpSecure').checked = s.smtp.secure !== false;
    }
  }

  function loadSmtpSettings() {
    const s = S.state.settings || {};
    if (s.smtp) {
      if ($('#smtpHost')) $('#smtpHost').value = s.smtp.host || '';
      if ($('#smtpPort')) $('#smtpPort').value = s.smtp.port || 465;
      if ($('#smtpUser')) $('#smtpUser').value = s.smtp.user || '';
      if ($('#smtpPass')) $('#smtpPass').value = s.smtp.pass || '';
      if ($('#smtpSecure')) $('#smtpSecure').checked = s.smtp.secure !== false;
    }
  }

  async function saveSmtpSettings() {
    const smtpCfg = {
      host: ($('#smtpHost') && $('#smtpHost').value.trim()) || '',
      port: Number(($('#smtpPort') && $('#smtpPort').value) || 465),
      user: ($('#smtpUser') && $('#smtpUser').value.trim()) || '',
      pass: ($('#smtpPass') && $('#smtpPass').value) || '',
      secure: !$('#smtpSecure') || $('#smtpSecure').checked !== false
    };
    await API.saveSettings({ smtp: smtpCfg });
    S.set({ settings: Object.assign({}, S.state.settings, { smtp: smtpCfg }) }, true);
    V.toast('发信设置已保存到本机', 'ok');
    const hint = $('#smtpSaveHint');
    if (hint) hint.textContent = '已保存 · ' + new Date().toLocaleTimeString('zh-CN');
  }

  async function boot() {
    if (window.nexusHost) document.body.classList.add('is-electron');
    // 国际化：尽早初始化（DOM 已就绪），语言偏好来自 localStorage / 后端设置
    if (window.NexusI18n) window.NexusI18n.init();
    const health = await API.health();
    S.set({ mode: API.mode }, true);
    if (health && health.dataDir) {
      const el = $('#dataDirPath');
      if (el) el.textContent = health.dataDir;
      $('#chatFoot').textContent = `本地服务 http://127.0.0.1 · v${health.version}`;
      const cv = document.getElementById('curVersion');
      if (cv) cv.textContent = 'v' + health.version;
      const av = document.getElementById('aboutVersion');
      if (av) av.textContent = 'NEXUS ' + health.version;
    } else {
      $('#chatFoot').textContent = '预览模式：未连接本地服务，回复为内置模拟内容';
      const cv = document.getElementById('curVersion');
      if (cv) cv.textContent = 'v—（预览）';
    }

    await loadSettings();
    const snap = await API.providers(true);
    applySnapshot(snap);

    bindComposer();
    bindGlobal();
    bindUpdate();
    updateStopButton();
    V.renderEmptyChips();
    startWave();
    const initial = (location.hash || '').replace('#', '');
    go(VIEW_META[initial] ? initial : 'overview');

    // 启动即完成识别（若后端缓存为空则会重新扫描）
    if (!snap || !snap.providers || !snap.providers.length) rescan(true);

    // 启动后台静默检查一次新版本（不打断用户，发现新版仅提示一次）
    try {
      const settings = await API.getSettings();
      if (!settings || settings.autoCheckUpdate !== false) {
        setTimeout(() => checkUpdate(false), 1500);
      }
    } catch { /* 预览模式忽略 */ }
  }

  // 供接入中心在通道变更后触发拓扑刷新 / 视图跳转；供菜单触发更新检查
  window.NexusApp = { go, rescan, applySnapshot, send, stop: stopActive, updateStopButton, checkUpdate };

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
