'use strict';
/**
 * 思维导图式编排画布
 * ------------------------------------------------------------
 * 世界坐标 + CSS transform 缩放平移；连线用 SVG 贝塞尔，节点用绝对定位 DOM。
 * 端口语义：
 *   input  → out
 *   ai     → in / out
 *   judge  → in / true / false
 *   loop   → in / body / exit
 *   output → in
 */
(function () {
  const S = window.NexusState;
  const API = window.NexusAPI;
  const V = window.NexusViews;

  const NODE_W = 208;
  const TYPE_META = {
    input: { badge: 'IN', color: '#5b8cff', title: '输入' },
    ai: { badge: 'AI', color: '#7b5cff', title: 'AI 节点' },
    judge: { badge: 'IF', color: '#f5b544', title: '判断' },
    loop: { badge: 'LOOP', color: '#ff7ac6', title: '循环' },
    output: { badge: 'OUT', color: '#34d399', title: '汇总' }
  };

  let flow = { id: 'default', name: '主流程', nodes: [], edges: [] };
  const view = { x: 48, y: 36, k: 1 };
  let selected = { type: null, id: null };
  let drag = null;
  let pan = null;
  let link = null;
  let running = false;
  let runAbort = null;
  let saveTimer = null;
  let mounted = false;

  const dom = {};
  const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

  /* ------------------------------------------------------------ 默认模板 */

  function defaultFlow() {
    const nodes = [
      { id: 'n-input', type: 'input', title: '用户提问', x: 40, y: 250, config: { label: '流程入口' } },
      { id: 'n-ai1', type: 'ai', title: '主答 · 自动路由', x: 320, y: 236, config: { providerId: '', prompt: '{{input}}' } },
      { id: 'n-judge', type: 'judge', title: '答案是否够长', x: 600, y: 236, config: { condition: 'result.length > 80' } },
      { id: 'n-loop', type: 'loop', title: '补充迭代', x: 880, y: 96, config: { iterations: 2, condition: 'result.length > 200' } },
      { id: 'n-ai2', type: 'ai', title: '扩写节点', x: 880, y: 330, config: { providerId: '', prompt: '在下面内容基础上补充两个要点：\n{{last}}' } },
      { id: 'n-out', type: 'output', title: '结果汇总', x: 1160, y: 250, config: { merge: 'last' } }
    ];
    const edges = [
      { id: 'e1', from: 'n-input', port: 'out', to: 'n-ai1' },
      { id: 'e2', from: 'n-ai1', port: 'out', to: 'n-judge' },
      { id: 'e3', from: 'n-judge', port: 'true', to: 'n-out' },
      { id: 'e4', from: 'n-judge', port: 'false', to: 'n-loop' },
      { id: 'e5', from: 'n-loop', port: 'body', to: 'n-ai2' },
      { id: 'e6', from: 'n-ai2', port: 'out', to: 'n-loop' },
      { id: 'e7', from: 'n-loop', port: 'exit', to: 'n-out' }
    ];
    return { id: 'default', name: '主流程', nodes, edges };
  }

  /* ---------------------------------------------------------------- 工具 */

  const byId = (id) => flow.nodes.find((n) => n.id === id);
  const nodeEl = (id) => dom.nodeLayer.querySelector(`[data-node="${id}"]`);

  function portPoint(nodeId, port) {
    const n = byId(nodeId);
    if (!n) return { x: 0, y: 0 };
    const el = nodeEl(nodeId);
    const h = el ? el.offsetHeight : 88;
    if (port === 'in') return { x: n.x, y: n.y + h / 2 };
    if (port === 'out') return { x: n.x + NODE_W, y: n.y + h / 2 };
    const ratio = { true: 0.34, false: 0.66, body: 0.34, exit: 0.66 }[port] ?? 0.5;
    return { x: n.x + NODE_W, y: n.y + h * ratio };
  }

  function pathOf(a, b) {
    const dx = Math.max(52, Math.abs(b.x - a.x) * 0.42);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }

  function applyView() {
    dom.stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    const zl = document.getElementById('zoomLabel');
    if (zl) zl.textContent = `${Math.round(view.k * 100)}%`;
  }

  function toWorld(clientX, clientY) {
    const r = dom.body.getBoundingClientRect();
    return {
      x: (clientX - r.left - view.x) / view.k,
      y: (clientY - r.top - view.y) / view.k
    };
  }

  /* -------------------------------------------------------------- 渲染 */

  function nodeBodyHtml(n) {
    const c = n.config || {};
    if (n.type === 'input') {
      return `<div class="node-line"><b>${V.esc(c.label || '流程入口')}</b></div>
              <div class="node-line mono">payload = 侧边输入框内容</div>`;
    }
    if (n.type === 'ai') {
      const p = S.providerById(c.providerId) || S.autoPick();
      const model = c.model || (p && p.models && p.models[0] && p.models[0].id) || '自动';
      const prompt = (c.prompt || '').replace(/\n/g, ' ');
      return `<div class="node-line"><b>${V.esc(p ? p.name : '自动路由')}</b> · ${V.esc(model)}</div>
              <div class="node-line mono">${V.esc(prompt.slice(0, 46) || '（未设置提示词）')}</div>
              <div class="node-line node-out" data-out="${V.esc(n.id)}"></div>`;
    }
    if (n.type === 'judge') {
      return `<div class="node-line">条件：<b>${V.esc(c.condition || 'result')}</b></div>
              <div class="node-line mono">真 → 上端口 · 假 → 下端口</div>`;
    }
    if (n.type === 'loop') {
      return `<div class="node-line">最多 <b>${V.esc(c.iterations || 2)}</b> 轮</div>
              <div class="node-line mono">${V.esc(c.condition ? '退出：' + c.condition : '跑满轮次后退出')}</div>`;
    }
    return `<div class="node-line">合并策略：<b>${V.esc(c.merge || 'last')}</b></div>
            <div class="node-line mono">收束全流程输出</div>`;
  }

  function portHtml(n) {
    const list = [];
    if (n.type !== 'input') list.push(`<div class="port in" data-port="in" data-node-id="${n.id}" data-label="输入"></div>`);
    if (n.type === 'judge') {
      list.push(`<div class="port out" data-port="true" data-node-id="${n.id}" data-label="真"></div>`);
      list.push(`<div class="port out" data-port="false" data-node-id="${n.id}" data-label="假"></div>`);
    } else if (n.type === 'loop') {
      list.push(`<div class="port out" data-port="body" data-node-id="${n.id}" data-label="循环体"></div>`);
      list.push(`<div class="port out" data-port="exit" data-node-id="${n.id}" data-label="退出"></div>`);
    } else if (n.type !== 'output') {
      list.push(`<div class="port out" data-port="out" data-node-id="${n.id}" data-label="输出"></div>`);
    }
    return list.join('');
  }

  function renderNodes() {
    dom.nodeLayer.innerHTML = flow.nodes.map((n) => {
      const meta = TYPE_META[n.type] || TYPE_META.ai;
      return `
        <div class="node" data-node="${n.id}" data-type="${n.type}"
             style="left:${n.x}px;top:${n.y}px">
          <div class="node-head">
            <span class="node-kind" style="background:${meta.color}"></span>
            <span class="node-title">${V.esc(n.title || meta.title)}</span>
            <span class="node-badge" style="color:${meta.color};border-color:${meta.color}33">${meta.badge}</span>
            <button class="node-del" data-del="${n.id}" title="删除节点">
              <svg class="ico"><use href="#i-close"/></svg>
            </button>
          </div>
          <div class="node-body">${nodeBodyHtml(n)}</div>
          ${portHtml(n)}
        </div>`;
    }).join('');

    const hint = dom.body.querySelector('.canvas-hint');
    if (hint) hint.style.display = flow.nodes.length ? 'none' : '';

    if (selected.type === 'node') {
      const el = nodeEl(selected.id);
      if (el) el.classList.add('is-sel');
    }
    updateHud();
  }

  function renderEdges() {
    const defs = `<defs>
      <marker id="nx-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="rgba(150,165,200,0.55)"/>
      </marker>
    </defs>`;

    const paths = flow.edges.map((e) => {
      const from = portPoint(e.from, e.port || 'out');
      const to = portPoint(e.to, 'in');
      const d = pathOf(from, to);
      const cls = ['edge-path'];
      if (e.port === 'true') cls.push('is-true');
      if (e.port === 'false') cls.push('is-false');
      if (e.port === 'body' || e.port === 'exit') cls.push('is-loop');
      if (selected.type === 'edge' && selected.id === e.id) cls.push('is-active');
      const label = e.port === 'true' ? '真' : e.port === 'false' ? '假' : e.port === 'body' ? '循环体' : e.port === 'exit' ? '退出' : '';
      const lx = (from.x + to.x) / 2;
      const ly = (from.y + to.y) / 2 - 5;
      return `<g data-edge="${e.id}">
        <path class="edge-hit" d="${d}"></path>
        <path class="${cls.join(' ')}" d="${d}" marker-end="url(#nx-arrow)"></path>
        ${label ? `<text class="edge-label" x="${lx}" y="${ly}" text-anchor="middle">${label}</text>` : ''}
      </g>`;
    }).join('');

    const draft = link
      ? `<path class="edge-draft" d="${pathOf(link.start, link.end)}"></path>`
      : '';

    dom.edgeLayer.innerHTML = defs + paths + draft;
  }

  function updateHud() {
    const el = document.getElementById('canvasHud');
    if (!el) return;
    el.innerHTML = `<span>节点 <b>${flow.nodes.length}</b></span><span>连线 <b>${flow.edges.length}</b></span><span>缩放 <b>${Math.round(view.k * 100)}%</b></span>`;
  }

  function rerender() {
    renderNodes();
    requestAnimationFrame(renderEdges);
  }

  /* ---------------------------------------------------------- 节点操作 */

  function addNode(type, x, y) {
    const meta = TYPE_META[type] || TYPE_META.ai;
    const node = {
      id: uid('n'),
      type,
      title: meta.title,
      x: Math.round(x == null ? (240 - view.x) / view.k : x),
      y: Math.round(y == null ? (240 - view.y) / view.k : y),
      config:
        type === 'ai' ? { providerId: '', prompt: '{{input}}' }
          : type === 'judge' ? { condition: 'result.length > 80' }
            : type === 'loop' ? { iterations: 2, condition: 'result.length > 200' }
              : type === 'output' ? { merge: 'last' }
                : { label: '流程入口' }
    };
    if (type === 'ai') {
      const pick = S.autoPick();
      node.config.providerId = pick ? pick.id : '';
    }
    // 依次错开，避免叠在一起
    const overlap = flow.nodes.filter((n) => Math.abs(n.x - node.x) < 24 && Math.abs(n.y - node.y) < 24).length;
    node.x += overlap * 26;
    node.y += overlap * 22;

    flow.nodes.push(node);
    rerender();
    select('node', node.id);
    persist();
    return node;
  }

  function deleteNode(id) {
    flow.nodes = flow.nodes.filter((n) => n.id !== id);
    flow.edges = flow.edges.filter((e) => e.from !== id && e.to !== id);
    if (selected.id === id) select(null, null);
    rerender();
    persist();
  }

  function addEdge(fromId, port, toId) {
    if (!fromId || !toId || fromId === toId) return null;
    const dup = flow.edges.some((e) => e.from === fromId && e.port === port && e.to === toId);
    if (dup) return null;
    const edge = { id: uid('e'), from: fromId, port: port || 'out', to: toId };
    flow.edges.push(edge);
    rerender();
    persist();
    return edge;
  }

  /* ------------------------------------------------------------ 属性面板 */

  function select(type, id) {
    selected = { type, id };
    dom.nodeLayer.querySelectorAll('.node').forEach((el) => el.classList.toggle('is-sel', type === 'node' && el.dataset.node === id));
    renderEdges();
    renderInspector();
  }

  function renderInspector() {
    const ins = dom.inspector;
    if (!ins) return;
    if (!selected.id || selected.type !== 'node') {
      ins.classList.remove('is-open');
      ins.innerHTML = '';
      return;
    }
    const n = byId(selected.id);
    if (!n) { ins.classList.remove('is-open'); return; }
    const meta = TYPE_META[n.type] || TYPE_META.ai;
    const c = n.config || {};
    let fields = '';

    if (n.type === 'input') {
      fields = field('入口标签', `<input class="ins-input" data-cfg="label" value="${V.esc(c.label || '')}">`);
    } else if (n.type === 'ai') {
      const providers = S.state.providers.filter((p) => p.chatCapable);
      const opts = [`<option value="">自动路由（推荐）</option>`]
        .concat(providers.map((p) => `<option value="${V.esc(p.id)}" ${c.providerId === p.id ? 'selected' : ''}>${V.esc(p.name)} · ${V.esc(V.STATUS_TEXT[p.status] || p.status)}</option>`))
        .join('');
      const cur = S.providerById(c.providerId);
      const modelOpts = [`<option value="">默认模型</option>`]
        .concat(((cur && cur.models) || []).slice(0, 80).map((m) => `<option value="${V.esc(m.id)}" ${c.model === m.id ? 'selected' : ''}>${V.esc(m.name || m.id)}</option>`))
        .join('');
      fields = field('通道', `<select class="ins-select" data-cfg="providerId">${opts}</select>`) +
        field('模型', `<select class="ins-select" data-cfg="model">${modelOpts}</select>`) +
        field('提示词', `<textarea class="ins-area" data-cfg="prompt" placeholder="支持 {{input}} 与 {{last}}">${V.esc(c.prompt || '')}</textarea>`, '{{input}} = 本轮用户输入；{{last}} = 上游节点输出') +
        field('系统约束', `<textarea class="ins-area" data-cfg="system" placeholder="可选">${V.esc(c.system || '')}</textarea>`);
    } else if (n.type === 'judge') {
      fields = field('判断条件', `<input class="ins-input" data-cfg="condition" value="${V.esc(c.condition || '')}">`, '可用 result / round / input，例如 result.length > 80') +
        `<div class="ins-hint">真 → 上端口；假 → 下端口。条件表达式在本机执行。</div>`;
    } else if (n.type === 'loop') {
      fields = field('最大轮次', `<input class="ins-input" type="number" min="1" max="12" data-cfg="iterations" value="${V.esc(c.iterations || 2)}">`) +
        field('退出条件', `<input class="ins-input" data-cfg="condition" value="${V.esc(c.condition || '')}">`, '留空则跑满轮次；expression 同判断节点');
    } else {
      fields = field('合并策略', `<select class="ins-select" data-cfg="merge">
          <option value="last" ${c.merge === 'last' ? 'selected' : ''}>取最后一个节点输出</option>
          <option value="all" ${c.merge === 'all' ? 'selected' : ''}>拼接全部输出</option>
        </select>`);
    }

    ins.innerHTML = `
      <div class="ins-head">
        <div>
          <span class="ins-kind">${meta.badge} · ${n.type}</span>
          <h4>${V.esc(n.title || meta.title)}</h4>
        </div>
        <button class="ins-close" id="insClose"><svg class="ico"><use href="#i-close"/></svg></button>
      </div>
      <div class="ins-body">
        ${field('节点名称', `<input class="ins-input" data-cfg="title" value="${V.esc(n.title || '')}">`)}
        ${fields}
      </div>
      <div class="ins-actions">
        <button class="tool-btn" id="insDelete"><svg class="ico"><use href="#i-trash"/></svg>删除节点</button>
      </div>`;
    ins.classList.add('is-open');
  }

  function field(label, control, hint) {
    return `<div class="ins-field"><span class="ins-label">${label}</span>${control}${hint ? `<span class="ins-hint">${hint}</span>` : ''}</div>`;
  }

  /* -------------------------------------------------------------- 运行 */

  function logLine(text, kind = '') {
    const list = dom.runlog.querySelector('.rl-list');
    if (!list) return;
    const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const el = document.createElement('div');
    el.className = `rl-item ${kind}`;
    el.innerHTML = `<span class="rl-time">${now}</span><span class="rl-text">${V.esc(text)}</span>`;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
  }

  function setRunState(text, cls) {
    const el = dom.runlog.querySelector('.rl-state');
    if (el) { el.textContent = text; el.className = `rl-state ${cls || ''}`; }
  }

  function clearRunMarks() {
    dom.nodeLayer.querySelectorAll('.node').forEach((el) => {
      el.classList.remove('is-running', 'is-done', 'is-error', 'is-skipped');
      const p = el.querySelector('.node-pulse');
      if (p) p.remove();
    });
    dom.edgeLayer.querySelectorAll('.edge-path').forEach((p) => p.classList.remove('is-active'));
    dom.nodeLayer.querySelectorAll('[data-out]').forEach((el) => { el.textContent = ''; });
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case 'flow-start':
        setRunState('RUNNING', 'is-run');
        logLine('流程开始', 'is-run');
        break;
      case 'node-start': {
        const el = nodeEl(ev.nodeId);
        if (el) {
          el.classList.remove('is-done', 'is-error');
          el.classList.add('is-running');
          if (!el.querySelector('.node-pulse')) {
            const pulse = document.createElement('div');
            pulse.className = 'node-pulse';
            el.appendChild(pulse);
          }
        }
        break;
      }
      case 'node-delta': {
        const out = dom.nodeLayer.querySelector(`[data-out="${ev.nodeId}"]`);
        if (out) out.textContent = String(ev.text).slice(-60);
        break;
      }
      case 'node-done': {
        const el = nodeEl(ev.nodeId);
        if (el) { el.classList.remove('is-running'); el.classList.add('is-done'); const p = el.querySelector('.node-pulse'); if (p) p.remove(); }
        if (ev.text) logLine(`✓ ${ev.text.slice(0, 70)}`, 'is-ok');
        break;
      }
      case 'node-error': {
        const el = nodeEl(ev.nodeId);
        if (el) { el.classList.remove('is-running'); el.classList.add('is-error'); const p = el.querySelector('.node-pulse'); if (p) p.remove(); }
        logLine(`✗ ${ev.text}${ev.hint ? ' · ' + ev.hint : ''}`, 'is-err');
        break;
      }
      case 'edge-active': {
        const p = dom.edgeLayer.querySelector(`[data-edge="${ev.edgeId}"] .edge-path`);
        if (p) { p.classList.add('is-active'); setTimeout(() => p.classList.remove('is-active'), 900); }
        break;
      }
      case 'flow-output':
        if (ev.text) logLine(`输出：${String(ev.text).slice(0, 90)}`, 'is-ok');
        break;
      case 'flow-done':
        setRunState('DONE', 'is-ok');
        logLine(`流程完成，共 ${ev.steps} 步`, 'is-ok');
        if (ev.text) {
          S.set({
            messages: S.state.messages.concat([{
              id: uid('m'),
              role: 'assistant',
              content: ev.text,
              providerName: '画布流程',
              model: flow.name
            }])
          });
        }
        break;
      case 'flow-error':
        setRunState('ERROR', 'is-err');
        logLine(`流程失败：${ev.text}`, 'is-err');
        V.toast(`流程执行失败：${ev.text}`, 'error');
        break;
      default:
        if (ev.text) logLine(ev.text);
    }
  }

  function stop() {
    if (!running || !runAbort) return;
    runAbort.abort();
    logLine('已停止输出与思考');
    if (window.NexusApp && window.NexusApp.updateStopButton) window.NexusApp.updateStopButton();
  }

  function isRunning() {
    return running;
  }

  async function run() {
    if (running) return;
    if (!flow.nodes.length) { V.toast('画布是空的，先添加节点', 'error'); return; }
    running = true;
    runAbort = new AbortController();
    if (window.NexusApp && window.NexusApp.updateStopButton) window.NexusApp.updateStopButton();
    const btn = document.getElementById('runFlow');
    if (btn) { btn.classList.add('is-running'); btn.innerHTML = '<svg class="ico"><use href="#i-stop"/></svg>运行中'; }
    dom.runlog.classList.add('is-open');
    const list = dom.runlog.querySelector('.rl-list');
    if (list) list.innerHTML = '';
    clearRunMarks();

    const input = (document.getElementById('promptInput').value || '').trim() || '用三句话说明你能做什么';
    try {
      await window.NexusEngine.runFlow(flow, { input, onEvent: handleEvent, maxSteps: 200, signal: runAbort.signal });
    } catch (err) {
      /* handleEvent 已经写过日志 */
    } finally {
      running = false;
      runAbort = null;
      if (btn) { btn.classList.remove('is-running'); btn.innerHTML = '<svg class="ico"><use href="#i-play"/></svg>运行流程'; }
      if (window.NexusApp && window.NexusApp.updateStopButton) window.NexusApp.updateStopButton();
      setTimeout(() => { dom.nodeLayer.querySelectorAll('.node.is-running').forEach((el) => el.classList.remove('is-running')); }, 600);
    }
  }

  /* ------------------------------------------------------------ 持久化 */

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const payload = { activeId: flow.id, flows: [{ id: flow.id, name: flow.name, nodes: flow.nodes, edges: flow.edges }] };
      API.saveFlows(payload);
    }, 500);
  }

  async function load() {
    let stored = null;
    try { stored = await API.getFlows(); } catch { /* ignore */ }
    if (stored && Array.isArray(stored.flows) && stored.flows.length) {
      const f = stored.flows.find((x) => x.id === stored.activeId) || stored.flows[0];
      if (f && Array.isArray(f.nodes) && f.nodes.length) {
        flow = { id: f.id || 'default', name: f.name || '主流程', nodes: f.nodes, edges: f.edges || [] };
        return;
      }
    }
    flow = defaultFlow();
  }

  /* ------------------------------------------------------------- 交互 */

  function bind() {
    // 画布空白处：拖拽平移 + 取消选中
    dom.body.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.node') || e.target.closest('.inspector') || e.target.closest('.runlog') || e.target.closest('.canvas-toolbar')) return;
      const isEdge = e.target.closest('[data-edge]');
      if (isEdge) {
        select('edge', isEdge.dataset.edge);
        return;
      }
      select(null, null);
      pan = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      dom.body.classList.add('is-panning');
      dom.body.setPointerCapture(e.pointerId);
    });

    dom.body.addEventListener('pointermove', (e) => {
      if (pan) {
        view.x = pan.vx + (e.clientX - pan.sx);
        view.y = pan.vy + (e.clientY - pan.sy);
        applyView();
        return;
      }
      if (drag) {
        const dx = (e.clientX - drag.sx) / view.k;
        const dy = (e.clientY - drag.sy) / view.k;
        const n = byId(drag.id);
        if (!n) return;
        n.x = Math.round(drag.nx + dx);
        n.y = Math.round(drag.ny + dy);
        const el = nodeEl(drag.id);
        if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
        renderEdges();
        return;
      }
      if (link) {
        link.end = toWorld(e.clientX, e.clientY);
        renderEdges();
        const hovered = document.elementFromPoint(e.clientX, e.clientY);
        const node = hovered && hovered.closest('.node');
        dom.nodeLayer.querySelectorAll('.node').forEach((el) => el.classList.toggle('is-target', !!node && el === node && el.dataset.node !== link.fromId));
        return;
      }
    });

    dom.body.addEventListener('pointerup', (e) => {
      if (pan) { pan = null; dom.body.classList.remove('is-panning'); }
      if (drag) {
        drag = null;
        dom.body.classList.remove('is-connecting');
        nodeEl(drag && drag.id);
        persist();
      }
      if (link) {
        const hovered = document.elementFromPoint(e.clientX, e.clientY);
        const node = hovered && hovered.closest('.node');
        if (node) addEdge(link.fromId, link.port, node.dataset.node);
        link = null;
        dom.nodeLayer.querySelectorAll('.node').forEach((el) => el.classList.remove('is-target'));
        renderEdges();
      }
    });

    // 缩放
    dom.body.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = toWorld(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      view.k = Math.min(2.2, Math.max(0.32, view.k * factor));
      const r = dom.body.getBoundingClientRect();
      view.x = e.clientX - r.left - before.x * view.k;
      view.y = e.clientY - r.top - before.y * view.k;
      applyView();
      renderEdges();
      updateHud();
    }, { passive: false });

    // 节点拖拽 / 连线 / 删除
    dom.nodeLayer.addEventListener('pointerdown', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); deleteNode(del.dataset.del); return; }

      const port = e.target.closest('.port');
      if (port) {
        e.stopPropagation();
        e.preventDefault();
        const fromId = port.dataset.nodeId;
        link = { fromId, port: port.dataset.port, start: portPoint(fromId, port.dataset.port), end: portPoint(fromId, port.dataset.port) };
        dom.body.classList.add('is-connecting');
        renderEdges();
        return;
      }

      const nodeEl2 = e.target.closest('.node');
      if (!nodeEl2) return;
      const n = byId(nodeEl2.dataset.node);
      if (!n) return;
      select('node', n.id);
      drag = { id: n.id, sx: e.clientX, sy: e.clientY, nx: n.x, ny: n.y };
      nodeEl2.classList.add('is-dragging');
      // 用 pointerup 时统一收尾
      const clear = () => {
        nodeEl2.classList.remove('is-dragging');
        window.removeEventListener('pointerup', clear);
      };
      window.addEventListener('pointerup', clear);
    });

    // 双击空白添加节点
    dom.body.addEventListener('dblclick', (e) => {
      if (e.target.closest('.node')) return;
      const p = toWorld(e.clientX, e.clientY);
      addNode('ai', p.x - NODE_W / 2, p.y - 40);
    });

    // 拖连接线到画布外松手
    window.addEventListener('pointerup', () => {
      if (link) { link = null; dom.body.classList.remove('is-connecting'); renderEdges(); }
    });

    // 属性面板
    dom.inspector.addEventListener('input', (e) => {
      const key = e.target.dataset.cfg;
      if (!key || selected.type !== 'node') return;
      const n = byId(selected.id);
      if (!n) return;
      let value = e.target.value;
      if (key === 'iterations') value = Number(value) || 1;
      n.config = n.config || {};
      n.config[key] = value;
      if (key === 'title') n.title = value;
      renderNodes();
      requestAnimationFrame(() => {
        renderEdges();
        const el = nodeEl(n.id);
        if (el) el.classList.add('is-sel');
      });
      persist();
    });
    dom.inspector.addEventListener('change', (e) => {
      const key = e.target.dataset.cfg;
      if (key === 'providerId') {
        const n = byId(selected.id);
        if (n) { n.config.model = ''; renderNodes(); renderInspector(); persist(); }
      }
    });
    dom.inspector.addEventListener('click', (e) => {
      if (e.target.closest('#insClose')) { select(null, null); return; }
      if (e.target.closest('#insDelete')) { if (selected.id) deleteNode(selected.id); }
    });

    // 键盘
    window.addEventListener('keydown', (e) => {
      if (S.state.view !== 'canvas') return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selected.type === 'node' && selected.id) { deleteNode(selected.id); e.preventDefault(); }
        else if (selected.type === 'edge' && selected.id) {
          flow.edges = flow.edges.filter((x) => x.id !== selected.id);
          select(null, null);
          rerender();
          persist();
          e.preventDefault();
        }
      }
      if (e.key === 'Escape') select(null, null);
    });
  }

  /* -------------------------------------------------------------- 生命周期 */

  async function init() {
    if (mounted) return;
    dom.body = document.getElementById('canvasBody');
    dom.stage = document.getElementById('stage');
    dom.edgeLayer = document.getElementById('edgeLayer');
    dom.nodeLayer = document.getElementById('nodeLayer');
    dom.inspector = document.getElementById('inspector');
    dom.runlog = document.getElementById('runlog');
    if (!dom.body) return;

    // 空态提示
    const hint = document.createElement('div');
    hint.className = 'canvas-hint';
    hint.innerHTML = `<h4>双击空白处添加 AI 节点</h4><p>从节点右侧圆点拖出连线 · 判断节点有「真/假」两个出口 · 循环节点有「循环体/退出」</p>`;
    dom.body.appendChild(hint);

    dom.runlog.innerHTML = `
      <div class="rl-head"><span>执行日志</span><span class="rl-state">IDLE</span></div>
      <div class="rl-list"></div>`;

    await load();
    bind();
    rerender();
    applyView();
    mounted = true;
  }

  function refresh() {
    if (!mounted) return;
    renderNodes();
    requestAnimationFrame(renderEdges);
  }

  function fit() {
    if (!flow.nodes.length) return;
    const r = dom.body.getBoundingClientRect();
    const xs = flow.nodes.map((n) => n.x);
    const ys = flow.nodes.map((n) => n.y);
    const xe = flow.nodes.map((n) => n.x + NODE_W);
    const ye = flow.nodes.map((n) => {
      const el = nodeEl(n.id);
      return n.y + (el ? el.offsetHeight : 90);
    });
    const minX = Math.min(...xs) - 40;
    const minY = Math.min(...ys) - 40;
    const maxX = Math.max(...xe) + 40;
    const maxY = Math.max(...ye) + 40;
    const k = Math.min(1.4, Math.max(0.32, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    view.k = k;
    view.x = (r.width - (maxX - minX) * k) / 2 - minX * k;
    view.y = (r.height - (maxY - minY) * k) / 2 - minY * k;
    applyView();
    renderEdges();
    updateHud();
  }

  function zoom(factor) {
    const r = dom.body.getBoundingClientRect();
    const cx = r.width / 2;
    const cy = r.height / 2;
    const before = { x: (cx - view.x) / view.k, y: (cy - view.y) / view.k };
    view.k = Math.min(2.2, Math.max(0.32, view.k * factor));
    view.x = cx - before.x * view.k;
    view.y = cy - before.y * view.k;
    applyView();
    renderEdges();
    updateHud();
  }

  function clear() {
    if (!flow.nodes.length) return;
    if (!window.confirm('清空画布上的全部节点与连线？')) return;
    flow.nodes = [];
    flow.edges = [];
    select(null, null);
    rerender();
    persist();
    dom.runlog.classList.remove('is-open');
  }

  window.NexusCanvas = { init, refresh, addNode, run, stop, isRunning, fit, zoom, clear, get flow() { return flow; } };
})();
