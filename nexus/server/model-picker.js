'use strict';
/**
 * 本地模型智能选择器
 * ------------------------------------------------------------
 * 纯 CPU 机器（无独显）上，模型体积直接决定输出速度。本模块根据：
 *   1. 用户在设置页选的策略（auto / fastest / quality / pinned）
 *   2. 当前问题的复杂度（长度、是否含推理/代码/长文关键词）
 *   3. 每个模型探测器标注的 speedTier / sizeGB
 * 自动挑一个「够用且最快」的本地模型，避免每次都拉起 27B 大模型卡死。
 *
 * 对外只暴露 pickLocalModel(provider, messages, settings) -> { model, reason, think, numCtx }
 */

/** 复杂任务的信号词：命中越多越倾向大模型 */
const COMPLEX_HINTS = [
  /代码|编程|debug|重构|写函数|算法|code|program|refactor|bug/i,
  /推理|证明|推导|分析|深入|详细|解释清楚|reason|prove|analyze|in depth/i,
  /长文|总结全文|翻译整篇|写作|论文|报告|小说|essay|article/i,
  /数学|计算|公式|math|equation/i,
  /翻译成|translate/i
];

/**
 * 估算问题复杂度 0..1
 * 综合消息长度与关键词命中数。
 */
function complexity(messages) {
  const text = (messages || [])
    .filter((m) => m && m.role === 'user')
    .map((m) => String(m.content || ''))
    .join('\n');
  const chars = text.length;
  // 500 字以上算长问题
  const lengthScore = Math.min(1, chars / 500);
  const hits = COMPLEX_HINTS.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  const hintScore = Math.min(1, hits / 2);
  return Math.min(1, lengthScore * 0.6 + hintScore * 0.6);
}

function tierRank(tier) {
  return { fast: 0, medium: 1, slow: 2 }[tier] != null
    ? { fast: 0, medium: 1, slow: 2 }[tier]
    : 1;
}

/** 微型模型（<1GB）虽快但基本不会正常对话，默认不作为对话首选 */
function isToy(m) {
  return (m.sizeGB != null && m.sizeGB < 1) || /135m|tiny|mini-?lm/i.test(m.id || '');
}

/**
 * 从 provider.models 里挑一个模型。
 * 返回 { model, reason, think, numCtx } 或 null（表示交给调用方默认逻辑）
 */
function pickLocalModel(provider, messages, settings) {
  if (!provider || provider.kind !== 'ollama') return null;
  const models = (provider.models || []).filter((m) => m && m.id);
  if (!models.length) return null;

  const s = settings || {};
  const policy = s.localModelPolicy || 'auto';
  const numCtx = Number(s.ollamaNumCtx) || 4096;
  const thinkDefault = s.ollamaThink !== true; // 默认 false

  // 用户在设置页钉住了某个模型 → 最高优先级，直接返回
  if (policy === 'pinned' && s.pinnedLocalModel) {
    const pinned = models.find((m) => m.id === s.pinnedLocalModel);
    if (pinned) {
      return { model: pinned.id, think: thinkDefault, numCtx, reason: '用户指定模型' };
    }
  }

  const sorted = models.slice().sort((a, b) => tierRank(a.speedTier) - tierRank(b.speedTier));
  // 对话候选：排除玩具级微型模型（它们只能做演示，回答不可靠）
  const usable = sorted.filter((m) => !isToy(m));
  const pool = usable.length ? usable : sorted;
  const fastest = pool[0];
  const best = pool[pool.length - 1];

  if (policy === 'fastest') {
    return { model: fastest.id, think: false, numCtx, reason: '始终最快' };
  }
  if (policy === 'quality') {
    return { model: best.id, think: thinkDefault, numCtx, reason: '始终高质量' };
  }

  // auto：按复杂度决定
  const cx = complexity(messages);
  let chosen;
  let reason;
  if (cx < 0.35) {
    chosen = fastest;
    reason = '简单问题 → 小模型快速响应';
  } else if (cx < 0.7) {
    // 中等：优先 fast 里最大的，否则 medium 里最小的
    const fastModels = pool.filter((m) => tierRank(m.speedTier) === 0);
    chosen = fastModels.length ? fastModels[fastModels.length - 1] : fastest;
    reason = '一般问题 → 均衡模型';
  } else {
    // 复杂：用能力最强但仍在内存安全范围内的模型
    const safe = pool.filter((m) => tierRank(m.speedTier) <= 1);
    chosen = safe.length ? safe[safe.length - 1] : fastest; // 超过内存的 slow 模型不自动选
    reason = '复杂问题 → 高质量模型（自动跳过超出内存的大模型）';
  }

  return {
    model: chosen.id,
    // 简单问题不需要思考链；复杂问题也默认关闭（用户可在设置里全局开启）
    think: thinkDefault && cx < 0.7 ? false : thinkDefault,
    numCtx,
    reason,
    complexity: Math.round(cx * 100) / 100
  };
}

module.exports = { pickLocalModel, complexity };
