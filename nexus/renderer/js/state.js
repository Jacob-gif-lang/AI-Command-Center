'use strict';
/** 极简状态容器：单向数据流 + 订阅，避免各处直接改 DOM 造成状态漂移 */
(function () {
  const listeners = new Set();

  const state = {
    view: 'overview',
    mode: 'unknown',
    snapshot: null,
    providers: [],
    /* 对话 */
    targets: [],            // 已选中的 provider id 列表
    activeProviderId: null, // 当前主通道
    models: {},             // providerId -> modelId
    messages: [],           // { id, role, content, providerName, model, error, hint, streaming }
    busy: false,
    /* 通话 */
    call: { participants: [], running: false, rounds: 2, mode: 'sequential' },
    /* 画布 */
    canvas: null,
    settings: {}
  };

  function emit() {
    for (const fn of listeners) {
      try { fn(state); } catch (e) { console.error(e); }
    }
  }

  function set(patch, silent) {
    Object.assign(state, patch);
    if (!silent) emit();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* -------- 查询辅助 -------- */

  function providerById(id) {
    return state.providers.find((p) => p.id === id) || null;
  }

  function chatReady() {
    return state.providers.filter((p) => p.chatCapable && (p.status === 'online' || p.status === 'restricted'));
  }

  /**
   * 自动路由（省额度优先）：
   *   本机 Ollama / LM Studio / dsh 网关 = 0 计费，永远排在最前；
   *   内置免费公共模型次之；按量计费的云端与自定义 API 只在没有本地/免费通道时兜底。
   *   想强制用某个模型时，在侧栏手动点选该通道即可覆盖自动路由。
   */
  function autoPick() {
    const pool = state.providers.filter((p) => p.chatCapable && p.status === 'online');
    if (!pool.length) return null;
    const capsOf = (p) => p.caps || [];
    const isLocal = (p) => {
      const id = String(p.id || '');
      return capsOf(p).includes('local') || capsOf(p).includes('offline') ||
        /^(ollama|lmstudio|jan|llamacpp|vllm|koboldcpp|gpt4all|dsh|demo)$/.test(id) ||
        /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(String(p.endpoint || ''));
    };
    const isFree = (p) => capsOf(p).includes('free') || p.id === 'free:pollinations';
    const score = (p) => {
      let s = p.latencyMs || 500;
      if (isLocal(p)) s -= 5000;                        // 本地 / 免费通道绝对优先
      else if (isFree(p)) s -= 2000;                    // 内置免费公共模型次之
      if (capsOf(p).includes('aggregator')) s += 60;
      return s;
    };
    return pool.slice().sort((a, b) => score(a) - score(b))[0];
  }

  function currentTarget() {
    if (state.activeProviderId) {
      const p = providerById(state.activeProviderId);
      if (p) return p;
    }
    return autoPick();
  }

  function history(limit = 12) {
    return state.messages
      .filter((m) => !m.error && m.role !== 'system')
      .slice(-limit)
      .map((m) => ({ role: m.role, content: m.content }))
      .filter((m) => m.content && m.content.trim());
  }

  window.NexusState = { state, set, subscribe, providerById, chatReady, autoPick, currentTarget, history };
})();
