'use strict';
/**
 * 模型接入中心 & 自愈修复（Model & API Hub）
 * ------------------------------------------------------------
 * 职责：
 *   1. 手填 API 地址 / 密钥 / 模型 → 测试连接 → 保存为一条自定义通道；
 *   2. 已接入通道的编辑、删除、刷新模型清单；
 *   3. 调用 /api/repair 做诊断 + 自动修复，并把报告逐条可视化；
 *   4. 暴露 runRepair() 给对话出错时的「一键修复」按钮与自动自愈逻辑。
 *
 * 安全：界面只读得到掩码密钥；编辑时密钥框始终为空，留空即沿用旧值。
 */
(function () {
  const API = window.NexusAPI;
  const V = window.NexusViews;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (V && V.esc) ? V.esc : (s) => String(s == null ? '' : s);

  const PRESETS = {
    moonshot: { name: 'Moonshot / Kimi（国内站）', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1', listPath: '/models' },
    deepseek: { name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', listPath: '/models' },
    ollama: { name: '本机 Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', listPath: '/api/tags' },
    lmstudio: { name: 'LM Studio', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', listPath: '/models' },
    dsh: { name: 'DeepSeek Harness 网关', kind: 'openai', baseUrl: 'http://127.0.0.1:8326/v1', listPath: '/models' }
  };

  const state = {
    editingId: null,
    models: [],
    report: null,
    busy: false,
    bound: false
  };

  function toast(msg, type) {
    if (V && V.toast) V.toast(msg, type);
  }

  function setBusy(on, el) {
    state.busy = !!on;
    if (el) el.classList.toggle('is-busy', !!on);
    $$('#hubDeepScanBtn, #hubRepairBtn, #hubDryRunBtn, #hubSaveBtn, #hubProbeBtn, #repairBtn').forEach((b) => {
      if (b) {
        b.disabled = !!on;
        if (b.id !== (el && el.id)) b.classList.toggle('is-busy', !!on);
      }
    });
  }

  /* ------------------------------------------------------------- 表单 */

  function formData() {
    return {
      name: $('#hubName').value.trim(),
      kind: $('#hubKind').value,
      baseUrl: $('#hubBaseUrl').value.trim(),
      listPath: $('#hubListPath').value.trim() || ($('#hubKind').value === 'ollama' ? '/api/tags' : '/models'),
      apiKey: $('#hubApiKey').value.trim(),
      modelId: $('#hubModelId').value || null
    };
  }

  function showProbe(message, kind) {
    const el = $('#hubProbeResult');
    if (!el) return;
    el.hidden = !message;
    el.className = 'hub-probe' + (kind ? ` is-${kind}` : '');
    el.textContent = message || '';
  }

  function fillModels(models, selected) {
    state.models = Array.isArray(models) ? models : [];
    const sel = $('#hubModelId');
    if (!sel) return;
    const opts = ['<option value="">自动选取第一个模型</option>'].concat(
      state.models.map((m) => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`)
    );
    sel.innerHTML = opts.join('');
    const want = selected || (state.models[0] && state.models[0].id);
    if (want && state.models.some((m) => m.id === want)) sel.value = want;
  }

  function resetForm() {
    state.editingId = null;
    state.models = [];
    const form = $('#hubForm');
    if (form) form.reset();
    $('#hubKind').value = 'openai';
    $('#hubListPath').value = '/models';
    $('#hubModelId').innerHTML = '<option value="">自动选取第一个模型</option>';
    $('#hubSaveBtn').textContent = '保存通道';
    $('#hubCancelBtn').hidden = true;
    $('#hubFormHint').textContent = '支持 OpenAI 兼容 / Ollama';
    showProbe('', null);
    $$('.hub-item').forEach((el) => el.classList.remove('is-editing'));
  }

  function editProvider(p) {
    state.editingId = p.id;
    $('#hubName').value = p.name || '';
    $('#hubKind').value = p.kind || 'openai';
    $('#hubBaseUrl').value = p.baseUrl || '';
    $('#hubListPath').value = p.listPath || '/models';
    $('#hubApiKey').value = '';
    $('#hubApiKey').placeholder = p.hasKey ? `已保存 ${esc(p.keyHint || '密钥')} · 留空表示不修改` : 'sk-…';
    fillModels(p.models || [], p.modelId);
    $('#hubSaveBtn').textContent = '保存修改';
    $('#hubCancelBtn').hidden = false;
    $('#hubFormHint').textContent = `正在编辑「${p.name}」`;
    showProbe(p.lastProbe && p.lastProbe.message
      ? `上次握手：${p.lastProbe.message}（${p.lastProbe.ok ? '成功' : '失败'}）`
      : '密钥留空表示沿用已保存的值', p.lastProbe && p.lastProbe.ok ? 'ok' : '');
    $$('.hub-item').forEach((el) => el.classList.toggle('is-editing', el.dataset.id === p.id));
    $('#hubName').focus();
    window.scrollTo && $('.view.is-active .view-scroll') && ($('.view.is-active .view-scroll').scrollTop = 0);
  }

  /* ------------------------------------------------------- 通道列表渲染 */

  function renderList(list) {
    const root = $('#hubList');
    const count = $('#hubCount');
    if (!root) return;
    if (count) count.textContent = `${list.length} 条自定义通道`;

    if (!list.length) {
      root.innerHTML = '<div class="hub-empty">还没有手动接入的通道。左侧填写 API 地址，点「测试连接」后再保存。</div>';
      return;
    }

    root.innerHTML = list.map((p) => {
      const lp = p.lastProbe;
      const ok = lp ? lp.ok : null;
      const badge = lp
        ? `<span class="hub-item-badge ${ok ? 'is-ok' : 'is-err'}">${ok ? '握手正常' : `异常 ${esc(lp.status || '')}`}</span>`
        : '<span class="hub-item-badge">未探测</span>';
      const models = (p.models || []).length;
      const defaultModel = p.modelId || '自动';
      const keyText = p.hasKey ? esc(p.keyHint || '已保存') : '无（本地服务）';
      return `
        <article class="hub-item ${state.editingId === p.id ? 'is-editing' : ''}" data-id="${esc(p.id)}">
          <div class="hub-item-top">
            <div>
              <div class="hub-item-name">${esc(p.name)}</div>
              <div class="hub-item-kind">${esc(p.kind === 'ollama' ? 'OLLAMA' : 'OPENAI 兼容')} · 自定义接入</div>
            </div>
            ${badge}
          </div>
          <div class="hub-item-url">${esc(p.baseUrl)} ${esc(p.listPath || '')}</div>
          <div class="hub-item-meta">
            <span>模型 <b>${models}</b></span>
            <span>默认 <b>${esc(defaultModel)}</b></span>
            <span>密钥 <b>${keyText}</b></span>
          </div>
          ${lp && !lp.ok ? `<div class="hub-item-meta"><span style="color:var(--warn)">${esc(lp.message || '上次握手失败')} · 可点「一键修复」</span></div>` : ''}
          <div class="hub-item-actions">
            <button class="hub-btn mini" data-cp="refresh" data-id="${esc(p.id)}">刷新模型</button>
            <button class="hub-btn mini" data-cp="edit" data-id="${esc(p.id)}">编辑</button>
            <button class="hub-btn mini" data-cp="test" data-id="${esc(p.id)}">测试通道</button>
            <span class="spacer"></span>
            <button class="hub-btn mini danger" data-cp="delete" data-id="${esc(p.id)}">删除</button>
          </div>
        </article>`;
    }).join('');
  }

  /* -------------------------------------------------- 全盘识别（磁盘模型） */

  function renderDiskScan(snap) {
    const root = $('#diskScanPanel');
    const meta = $('#diskScanMeta');
    if (!root || !snap) return;
    const ds = snap.diskScan || {};
    const all = (snap.providers || []).filter((p) => p.source === 'disk-scan');
    const diskProviders = all.filter((p) => (p.models || []).length);

    if (meta) {
      meta.textContent = ds.findings && ds.findings.length
        ? `${ds.findings.join(' · ')} · 扫描耗时 ${ds.elapsedMs || 0}ms · ${ds.deep ? '全盘深度' : '快速'}`
        : '扫描整个电脑寻找 AI 模型（含非默认盘符、独立 GGUF 文件），只读不改文件';
    }

    if (!diskProviders.length) {
      root.innerHTML = `<div class="hub-empty">本次扫描没有在磁盘上发现可用模型文件。模型通常会放在 Ollama / LM Studio 的默认目录，或 .gguf 文件所在文件夹。</div>`;
      return;
    }

    root.innerHTML = diskProviders.map((p) => {
      const isOllama = p.id === 'disk:ollama';
      const rows = (p.models || []).map((m) => {
        const size = m.sizeGB ? `${m.sizeGB} GB` : (m.suspicious ? '体积异常' : '—');
        const tier = m.speedTier && m.speedTier !== 'unknown'
          ? `<span class="disk-tag">${esc(m.speedTier === 'fast' ? '快速' : m.speedTier === 'medium' ? '中等' : '较慢')}</span>` : '';
        const warn = m.suspicious ? '<span class="disk-tag is-warn">疑似占位/不完整</span>' : '';
        const extra = m.params ? `<span class="disk-tag">${esc(String(m.params).slice(0, 24))}</span>` : '';
        const pathLine = m.filePath
          ? `<div class="disk-model-path">${esc((m.filePath || '').replace(/\\/g, ' › '))}</div>` : '';
        return `<div class="disk-model-row">
          <span class="disk-model-name">${esc(m.name)}</span>
          <span class="disk-model-size">${esc(size)}</span>
          ${tier}${warn}${extra}
          ${pathLine}
        </div>`;
      }).join('');
      const ph = (p.placeholders || []).length;
      return `<div class="disk-provider">
        <div class="disk-provider-head">
          <span class="disk-provider-name">${esc(p.name)}</span>
          <span class="disk-provider-count">${p.modelCount || 0} 个</span>
        </div>
        <div class="disk-provider-note">${esc(p.note || p.detail || '')}</div>
        <div class="disk-model-list">${rows}</div>
        ${isOllama ? `<div class="disk-provider-tip">提示：这些模型已在磁盘上。启动 Ollama 后即可在左侧模型列表直接对话；也可在下方「新增通道」里点「本机 Ollama」快速接入。</div>` : ''}
      </div>`;
    }).join('');
  }

  async function runDeepScan(btn) {
    if (state.busy) return;
    setBusy(true, btn);
    if (btn) btn.classList.add('is-busy');
    const root = $('#diskScanPanel');
    if (root) root.innerHTML = `<div class="hub-empty">正在全盘扫描本机磁盘，可能需要几秒…</div>`;
    try {
      const snap = await API.deepDetect();
      renderDiskScan(snap);
      // 让主界面同步最新拓扑与模型数量
      if (window.NexusApp && typeof window.NexusApp.applySnapshot === 'function') {
        window.NexusApp.applySnapshot(snap);
      } else if (window.NexusApp && typeof window.NexusApp.rescan === 'function') {
        window.NexusApp.rescan(false);
      }
      toast(`全盘识别完成：${(snap.summary && snap.summary.diskModels) || 0} 个本机模型`, 'ok');
    } catch (err) {
      if (root) root.innerHTML = `<div class="hub-empty" style="color:var(--err)">扫描失败：${esc(err.message)}</div>`;
      toast(`全盘识别失败：${err.message}`, 'error');
    } finally {
      setBusy(false, btn);
      if (btn) btn.classList.remove('is-busy');
    }
  }

  /* --------------------------------------------------------- 报告渲染 */

  function renderReport(report) {
    const root = $('#hubReport');
    const meta = $('#hubRepairMeta');
    if (!root) return;
    state.report = report;

    if (!report) {
      root.innerHTML = '<div class="hub-empty">尚未运行诊断。点击「一键修复」开始体检并自动修复。</div>';
      if (meta) meta.textContent = '检查自定义通道、dsh 配置、运行时、网关与钱包';
      return;
    }
    if (!report.ok) {
      root.innerHTML = `<div class="hub-empty" style="color:var(--err)">${esc(report.message || '诊断失败')}</div>`;
      return;
    }

    const findings = report.findings || [];
    const cls = report.fixedCount ? 'is-ok' : (report.manualCount ? 'is-warn' : 'is-ok');
    const head = `
      <div class="hub-report-summary ${cls}">
        <svg class="ico"><use href="#i-spark"/></svg>
        <span>${esc(report.summary || '诊断完成')}</span>
        <small>${report.dryRun ? '仅体检 · 未修改文件' : `耗时 ${report.durationMs}ms`} · ${new Date(report.startedAt).toLocaleString('zh-CN', { hour12: false })}</small>
      </div>`;

    const body = findings.length ? findings.map((f) => `
      <div class="hub-finding">
        <span class="hub-finding-mark ${f.fixed ? 'is-fixed' : 'is-manual'}">${f.fixed ? '✓' : '!'}</span>
        <div class="hub-finding-body">
          <div class="hub-finding-title">${esc(f.title)}</div>
          <div class="hub-finding-detail">${esc(f.detail)}</div>
          <div class="hub-finding-tags">
            <span class="hub-finding-tag ${f.fixed ? 'is-fixed' : 'is-manual'}">${f.fixed ? '已自动修复' : '需手动处理'}</span>
            <span class="hub-finding-tag">${esc(f.level === 'auto' ? '可自动' : '人工')}</span>
            <span class="hub-finding-tag">${esc(({ high: '高', mid: '中', low: '低' })[f.severity] || f.severity)}优先级</span>
            ${f.action ? `<span class="hub-finding-tag">建议：${esc(f.action)}</span>` : ''}
          </div>
        </div>
      </div>`).join('') : '<div class="hub-empty">体检通过：没有发现异常，所有通道状态正常。</div>';

    const restart = report.needRestart
      ? '<div class="hub-restart-note">配置已修改并备份，需重启 DeepSeek Harness 后生效；dsh 相关改动不会自动重启应用。</div>'
      : '';
    const changed = (report.changedFiles && report.changedFiles.length)
      ? `<div class="hub-finding-detail" style="padding:0 2px;color:var(--text-3)">涉及文件：${esc(report.changedFiles.join('、'))}</div>`
      : '';

    root.innerHTML = head + body + restart + changed;
    if (meta) meta.textContent = `修复 ${report.fixedCount} 项 · 待手动 ${report.manualCount} 项`;
  }

  function renderHistory(entries) {
    const root = $('#hubHistory');
    if (!root) return;
    if (!entries || !entries.length) {
      root.innerHTML = '<div class="hub-empty">暂无记录</div>';
      return;
    }
    root.innerHTML = entries.slice(0, 12).map((e) => `
      <span class="hub-history-item">${esc(new Date(e.at).toLocaleString('zh-CN', { hour12: false }))}
        · 修复 <b>${e.fixedCount}</b> 项 · 手动 <i>${e.manualCount}</i> 项${e.needRestart ? ' · 需重启' : ''}
      </span>`).join('');
  }

  /* ------------------------------------------------------------- 动作 */

  function notifyTopology() {
    // 通道变更后让主界面重新拉取拓扑，侧栏与画布立即出现/移除该通道
    if (window.NexusApp && typeof window.NexusApp.rescan === 'function') {
      window.NexusApp.rescan(false);
    }
  }

  async function refresh() {
    try {
      const [list, hist] = await Promise.all([API.listCustom(), API.repairHistory()]);
      renderList(list.providers || []);
      renderHistory(hist.entries || []);
    } catch (err) {
      const root = $('#hubList');
      if (root) root.innerHTML = `<div class="hub-empty" style="color:var(--err)">${esc(err.message)}</div>`;
    }
  }

  async function doProbe(payload, label) {
    showProbe('正在握手，请稍候…', '');
    try {
      const r = await API.probeCustom(payload);
      if (r.ok) {
        fillModels(r.models, payload.modelId);
        showProbe(`✓ ${r.message} · HTTP ${r.status} · ${r.latencyMs}ms${r.models.length ? ' · 已更新下方模型列表' : ''}`, 'ok');
        toast(`${label || '连接'}成功：${r.models.length} 个模型`, 'ok');
      } else {
        showProbe(`✗ ${r.message}`, 'err');
        toast(`连接失败：${r.message}`, 'error');
      }
      return r;
    } catch (err) {
      showProbe(`✗ ${err.message}`, 'err');
      toast(err.message, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function probeForm(el) {
    const d = formData();
    if (!d.baseUrl) { showProbe('请先填写 API 地址', 'err'); return; }
    setBusy(true, el);
    await doProbe(d, '测试连接');
    setBusy(false, el);
  }

  async function saveForm(e) {
    e.preventDefault();
    const d = formData();
    if (!d.name || !d.baseUrl) { showProbe('名称和 API 地址不能为空', 'err'); return; }

    const btn = $('#hubSaveBtn');
    setBusy(true, btn);
    try {
      const r = state.editingId
        ? await API.updateCustom(state.editingId, d)
        : await API.createCustom(d);
      if (r && r.ok === false) throw new Error(r.message || r.error || '保存失败');
      const probe = r && r.probe;
      showProbe(probe
        ? `${probe.ok ? '✓' : '!'} 通道已保存 · ${probe.message}`
        : '✓ 通道已保存', probe && probe.ok ? 'ok' : '');
      toast(state.editingId ? '通道已更新' : `已接入「${d.name}」`, 'ok');
      resetForm();
      await refresh();
      notifyTopology();
    } catch (err) {
      showProbe(`✗ 保存失败：${err.message}`, 'err');
      toast(`保存失败：${err.message}`, 'error');
    } finally {
      setBusy(false, btn);
    }
  }

  async function onListAction(e) {
    const btn = e.target.closest('[data-cp]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.cp;
    const list = (state.listCache || []);
    const p = list.find((x) => x.id === id);

    if (action === 'edit' && p) { editProvider(p); return; }
    if (action === 'test') {
      setBusy(true, btn);
      try {
        const r = await API.testCustom(id);
        showProbe(r.ok
          ? `✓ 「${r.name || id}」握手正常 · HTTP ${r.status} · ${r.latencyMs}ms · ${(r.models || []).length} 个模型`
          : `✗ 「${r.name || id}」握手失败：${r.message}`, r.ok ? 'ok' : 'err');
        toast(r.ok ? `通道正常：${(r.models || []).length} 个模型` : `通道异常：${r.message}`, r.ok ? 'ok' : 'error');
      } catch (err) {
        showProbe(`✗ 复测失败：${err.message}`, 'err');
        toast(`复测失败：${err.message}`, 'error');
      }
      setBusy(false, btn);
      return;
    }
    if (action === 'refresh') {
      setBusy(true, btn);
      try {
        const r = await API.refreshCustomModels(id);
        toast(r && r.probe && r.probe.ok
          ? `模型清单已更新：${(r.probe.models || []).length} 个`
          : `刷新未成功：${r && r.probe ? r.probe.message : '未知原因'}`, r && r.probe && r.probe.ok ? 'ok' : 'error');
        await refresh();
        notifyTopology();
      } catch (err) { toast(`刷新失败：${err.message}`, 'error'); }
      setBusy(false, btn);
      return;
    }
    if (action === 'delete') {
      const name = p ? p.name : id;
      if (!window.confirm(`确定删除通道「${name}」？该操作只删除 NEXUS 里的配置，不会影响上游服务。`)) return;
      setBusy(true, btn);
      try {
        await API.deleteCustom(id);
        if (state.editingId === id) resetForm();
        toast('通道已删除', 'ok');
        await refresh();
        notifyTopology();
      } catch (err) { toast(`删除失败：${err.message}`, 'error'); }
      setBusy(false, btn);
    }
  }

  /** 诊断 + 修复。auto=false 为只体检不落盘；silent=true 用于后台自动自愈 */
  async function runRepair(auto = true, opts = {}) {
    if (state.busy) return null;
    const el = $('#hubRepairBtn');
    setBusy(true, el);
    if (!opts.silent) {
      const root = $('#hubReport');
      if (root) root.innerHTML = `<div class="hub-empty">${auto ? '正在诊断并自动修复…' : '正在体检（不会修改任何文件）…'}</div>`;
    }
    let report = null;
    try {
      report = await API.repair(auto);
      renderReport(report);
      await refresh();
      if (report.fixedCount) notifyTopology();
      if (!opts.silent) {
        toast(report.summary, report.fixedCount || !report.manualCount ? 'ok' : 'error');
      }
    } catch (err) {
      renderReport({ ok: false, message: err.message });
      if (!opts.silent) toast(`修复失败：${err.message}`, 'error');
      report = { ok: false, message: err.message, fixedCount: 0, manualCount: 0, findings: [] };
    } finally {
      setBusy(false, el);
    }
    return report;
  }

  /* ------------------------------------------------------------- 绑定 */

  function bind() {
    if (state.bound) return;
    state.bound = true;

    $('#hubForm').addEventListener('submit', saveForm);
    $('#hubProbeBtn').addEventListener('click', (e) => probeForm(e.currentTarget));
    const deepBtn = $('#hubDeepScanBtn');
    if (deepBtn) deepBtn.addEventListener('click', (e) => runDeepScan(e.currentTarget));
    $('#hubCancelBtn').addEventListener('click', resetForm);
    $('#hubRepairBtn').addEventListener('click', () => runRepair(true));
    $('#hubDryRunBtn').addEventListener('click', () => runRepair(false));
    $('#hubList').addEventListener('click', onListAction);

    $('#hubKind').addEventListener('change', (e) => {
      const lp = $('#hubListPath');
      if (lp) lp.value = e.target.value === 'ollama' ? '/api/tags' : '/models';
    });

    document.addEventListener('click', (e) => {
      const preset = e.target.closest('[data-hubpreset]');
      if (!preset) return;
      const p = PRESETS[preset.dataset.hubpreset];
      if (!p) return;
      $('#hubName').value = p.name;
      $('#hubKind').value = p.kind;
      $('#hubBaseUrl').value = p.baseUrl;
      $('#hubListPath').value = p.listPath;
      $('#hubApiKey').value = '';
      $('#hubApiKey').placeholder = p.kind === 'ollama' ? '本地服务无需密钥' : 'sk-…';
      fillModels([], null);
      showProbe(p.kind === 'ollama' ? '已填充 Ollama 本机地址，直接点「测试连接」即可。' : '已填充地址，请填写 API Key 后点「测试连接」。', '');
    });

    // 顶栏「一键修复」：跳到接入页并执行
    const top = $('#repairBtn');
    if (top) top.addEventListener('click', () => {
      if (window.NexusApp && window.NexusApp.go) window.NexusApp.go('hub');
      runRepair(true);
    });
  }

  function onShow() {
    refresh();
    const snap = window.NexusState && window.NexusState.state && window.NexusState.state.snapshot;
    if (snap && snap.diskScan) renderDiskScan(snap);
  }

  async function init() {
    bind();
    // 缓存列表供编辑/测试按钮读取（renderList 时同步）
    const original = API.listCustom;
    API.listCustom = async function () {
      const r = await original.call(API);
      state.listCache = (r && r.providers) || [];
      return r;
    };
    await refresh();
  }

  window.NexusHub = { init, onShow, refresh, runRepair, renderReport, renderDiskScan, runDeepScan, state };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
