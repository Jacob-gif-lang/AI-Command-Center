'use strict';
/** AI 群聊视图：微信群聊式多人对话的渲染与交互 */
(function () {
  const S = window.NexusState;
  const API = window.NexusAPI;
  const V = window.NexusViews;
  const $ = (s, r = document) => r.querySelector(s);
  const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const state = {
    members: [],        // 已选成员 id
    msgs: [],           // { id, role, name, text, model, bridge, tag, task, streaming, error }
    running: false,
    abort: null,
    requestId: null
  };

  const MODE_LABEL = {
    delegate: '智能分工',
    broadcast: '全员回答',
    relay: '轮流接龙'
  };

  function chatProviders() {
    // 所有能发言的节点（含桥接节点），优先在线可对话
    return S.state.providers.filter((p) => p.chatCapable && (p.status === 'online' || p.status === 'restricted'));
  }

  function renderMembers() {
    const box = $('#groupMembers');
    if (!box) return;
    const all = chatProviders();
    if (!state.members.length) {
      // 默认选前 2~3 位（本地/免费优先的顺序已由 detector 排好）
      state.members = all.slice(0, Math.min(3, all.length)).map((p) => p.id);
    }
    if (!all.length) {
      box.innerHTML = '<span class="section-hint">暂无可对话的 AI，请先启动本机模型或点「重新识别」</span>';
      return;
    }
    box.innerHTML = all.map((p) => {
      const on = state.members.includes(p.id);
      const initial = (p.name || 'AI').trim().charAt(0).toUpperCase();
      const kind = p.id === 'free:pollinations' ? 'free' : p.kind;
      return `<button class="gm-chip ${on ? 'is-on' : ''}" data-gm="${V.esc(p.id)}" data-kind="${V.esc(kind)}" title="${V.esc(p.detail || p.name)}">
        <span class="gm-avatar">${V.esc(initial)}</span>
        <span>${V.esc(p.name)}</span>
        <span class="gm-check">${on ? '✓' : '+'}</span>
      </button>`;
    }).join('');
  }

  function setStatus(text, live) {
    const el = $('#groupStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-live', !!live);
  }

  function scrollBottom() {
    const el = $('#groupScroll');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function renderMsgs() {
    const box = $('#groupMsgs');
    if (!box) return;
    const empty = $('#groupEmpty');
    if (empty) empty.hidden = state.msgs.length > 0;

    for (const m of state.msgs) {
      let el = box.querySelector(`[data-gmid="${m.id}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'gm-msg' + (m.role === 'user' ? ' is-user' : '') + (m.error ? ' is-error' : '');
        el.dataset.gmid = m.id;
        const initial = (m.name || 'AI').trim().charAt(0).toUpperCase();
        el.innerHTML = `
          <div class="gm-avatar">${V.esc(initial)}</div>
          <div class="gm-bubble-wrap">
            <div class="gm-name">
              <b>${V.esc(m.name || '')}</b>
              <span class="gm-tag-slot"></span>
            </div>
            <div class="gm-bubble"></div>
            <div class="gm-model"></div>
          </div>`;
        box.appendChild(el);
      }
      const bubble = $('.gm-bubble', el);
      if (bubble.textContent !== m.text) bubble.textContent = m.text;
      bubble.classList.toggle('is-streaming', !!m.streaming);

      const tagSlot = $('.gm-tag-slot', el);
      if (tagSlot) {
        let tags = '';
        if (m.tag) tags += `<span class="gm-tag ${m.tag === 'host' ? 'host' : ''}">${V.esc(modeTag(m.tag))}</span>`;
        if (m.bridge) tags += `<span class="gm-bridge" title="${V.esc(m.bridge.reason || '')}">由 ${V.esc(m.bridge.speakerName || '在线模型')} 代答</span>`;
        if (tagSlot.innerHTML !== tags) tagSlot.innerHTML = tags;
      }
      const modelEl = $('.gm-model', el);
      if (modelEl) {
        const txt = m.task ? `任务：${m.task}` : (m.model || '');
        if (modelEl.textContent !== txt) modelEl.textContent = txt;
      }
      el.classList.toggle('is-error', !!m.error);
    }
    scrollBottom();
  }

  function modeTag(tag) {
    return tag === 'host' ? '主持人' : tag === 'summary' ? '汇总' : tag === 'member' ? '成员' : '';
  }

  function addSys(text, isErr) {
    const box = $('#groupMsgs');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'gm-sys' + (isErr ? ' is-err' : '');
    el.textContent = text;
    box.appendChild(el);
    scrollBottom();
  }

  function flushRender() {
    requestAnimationFrame(renderMsgs);
  }

  function markStopped() {
    let changed = false;
    for (const m of state.msgs) {
      if (m.streaming) {
        m.streaming = false;
        if (!(m.text || '').endsWith('（已停止）')) m.text = (m.text || '') + '（已停止）';
        changed = true;
      }
    }
    if (changed) flushRender();
  }

  /** 停止整场群聊：正在说的成员立即收尾，其余不再开麦 */
  function stop() {
    if (!state.running) return;
    if (state.requestId && API.stopGroup) API.stopGroup(state.requestId).catch(() => {});
    if (state.abort) state.abort.abort();
    markStopped();
    setStatus('已停止输出与思考', false);
    const sendBtn = $('#groupSend');
    if (sendBtn) sendBtn.disabled = false;
    if (window.NexusApp && window.NexusApp.updateStopButton) window.NexusApp.updateStopButton();
  }

  function isRunning() {
    return state.running;
  }

  async function send(text) {
    if (state.running) { V.toast('群聊进行中，请稍候', 'error'); return; }
    const input = $('#groupInput');
    const content = (text == null ? input.value : text).trim();
    if (!content) return;
    if (!state.members.length) { V.toast('请先在上方选择至少一位群成员', 'error'); return; }

    const mode = ($('#groupMode') && $('#groupMode').value) || 'delegate';
    const members = state.members.map((id) => {
      const p = S.providerById(id);
      return p ? { id: p.id, name: p.name } : { id };
    });

    state.msgs.push({ id: uid('u'), role: 'user', name: '你', text: content, streaming: false });
    if (input) input.value = '';
    state.running = true;
    state.abort = new AbortController();
    state.requestId = `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setStatus(`${MODE_LABEL[mode] || mode} · 群聊进行中…`, true);
    const sendBtn = $('#groupSend');
    if (sendBtn) sendBtn.disabled = true;
    if (window.NexusApp && window.NexusApp.updateStopButton) window.NexusApp.updateStopButton();
    renderMsgs();

    const active = new Map(); // mid -> msg
    try {
      await API.group({ question: content, members, mode, maxTokens: 700, requestId: state.requestId }, (evt) => {
        if (evt.type === 'group_start') {
          setStatus(`${MODE_LABEL[evt.mode] || evt.mode} · ${evt.members.length} 位成员已就位`, true);
        } else if (evt.type === 'plugin') {
          addSys(evt.message, !evt.ok);
          if (evt.needRescan && window.NexusApp) window.NexusApp.rescan(false);
        } else if (evt.type === 'message_start') {
          const m = {
            id: evt.mid, role: 'assistant', name: evt.name || 'AI',
            text: '', model: '', bridge: null, tag: evt.role || '',
            task: evt.task || '', streaming: true, error: false
          };
          state.msgs.push(m);
          active.set(evt.mid, m);
          flushRender();
        } else if (evt.type === 'message_done') {
          let m = active.get(evt.mid);
          if (!m) {
            m = { id: evt.mid, role: 'assistant', name: evt.name || 'AI', text: '', tag: evt.role || '', task: evt.task || '' };
            state.msgs.push(m);
          }
          m.text = evt.text || '（无内容）';
          m.model = evt.model || '';
          m.bridge = evt.bridge || null;
          m.streaming = false;
          flushRender();
        } else if (evt.type === 'message_error') {
          let m = active.get(evt.mid);
          if (!m) { m = { id: evt.mid, role: 'assistant', name: evt.name || 'AI', text: '' }; state.msgs.push(m); }
          m.text = `（${m.name} 发言失败：${evt.message || '未知错误'}）`;
          m.streaming = false;
          m.error = true;
          flushRender();
        } else if (evt.type === 'stopped') {
          markStopped();
          setStatus('已停止输出与思考', false);
        } else if (evt.type === 'error') {
          addSys(evt.message || '群聊出错', true);
        } else if (evt.type === 'group_done') {
          setStatus('群聊完成', false);
        }
      }, state.abort.signal);
    } catch (err) {
      if (state.abort && state.abort.signal.aborted) {
        markStopped();
        setStatus('已停止输出与思考', false);
      } else {
        addSys(`群聊连接失败：${err.message}`, true);
        setStatus('群聊中断', false);
      }
    } finally {
      state.running = false;
      state.abort = null;
      state.requestId = null;
      if (sendBtn) sendBtn.disabled = false;
      if (window.NexusApp && window.NexusApp.updateStopButton) window.NexusApp.updateStopButton();
      renderMsgs();
    }
  }

  function bind() {
    document.addEventListener('click', (e) => {
      const gm = e.target.closest('[data-gm]');
      if (gm) {
        const id = gm.dataset.gm;
        const i = state.members.indexOf(id);
        if (i >= 0) state.members.splice(i, 1); else state.members.push(id);
        renderMembers();
        return;
      }
      const preset = e.target.closest('[data-group-preset]');
      if (preset) { send(preset.dataset.groupPreset); return; }
    });

    const input = $('#groupInput');
    if (input) {
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(120, input.scrollHeight) + 'px';
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });
    }
    const sendBtn = $('#groupSend');
    if (sendBtn) sendBtn.addEventListener('click', () => send());
    const clearBtn = $('#groupClear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      state.msgs = [];
      renderMsgs();
      setStatus('', false);
    });
  }

  function onShow() {
    renderMembers();
    // 同步成员列表（拓扑刷新后可能有新通道/新插件）
    const valid = new Set(chatProviders().map((p) => p.id));
    state.members = state.members.filter((id) => valid.has(id));
    renderMembers();
    if (!$('#groupPresets').dataset.ready) {
      const presets = [
        '帮我规划一个多 AI 协作方案',
        '分析一下本地模型的优缺点',
        '用一个问题测试各位的能力'
      ];
      $('#groupPresets').innerHTML = presets.map((p) => `<button class="chip" data-group-preset="${V.esc(p)}">${V.esc(p)}</button>`).join('');
      $('#groupPresets').dataset.ready = '1';
    }
    renderMsgs();
  }

  let bound = false;
  window.NexusGroup = {
    onShow() {
      if (!bound) { bind(); bound = true; }
      onShow();
    },
    send,
    stop,
    isRunning
  };
})();
