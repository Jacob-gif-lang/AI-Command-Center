'use strict';
/**
 * 免费兜底通道 + 发言人桥接（Speaker Bridge）
 * ------------------------------------------------------------
 * 两个承诺：
 *   1. 用户零配置时也有一个真实可用的免费模型（免密钥公共端点）；
 *   2. 界面上出现的每一个 AI 对象都能「说话」——不能自己推理的节点
 *      （应用宿主 / MCP 工具 / 当前离线的端点）自动桥接到在线通道代答，
 *      并在回复里标注实际发言人。
 *
 * 免费通道不参与 detect 握手（不做额外请求、不消耗任何密钥额度），
 * 只在拓扑组装时静态注入，因此不会拖慢识别，也不会在离线时让整个拓扑为空。
 */

const FREE_ID = 'free:pollinations';

/** 免密钥、无需注册即可调用的公共 OpenAI 兼容端点 */
const FREE_TEMPLATE = {
  id: FREE_ID,
  name: 'NEXUS 免费模型',
  vendor: 'Pollinations',
  kind: 'openai',
  endpoint: 'https://text.pollinations.ai/openai',
  status: 'online',
  caps: ['chat', 'free', 'cloud', 'builtin'],
  source: 'builtin-free',
  requiresKey: false,
  chatCapable: true,
  detail: '免密钥公共模型 · 无需配置即可使用（匿名额度有限，需联网）',
  note: '零配置免费通道，由 Pollinations 提供',
  models: [
    { id: 'openai', name: '免费通用 · gpt-oss-20b' },
    { id: 'openai-large', name: '免费增强（额度收紧）' },
    { id: 'mistral', name: '免费 Mistral（额度收紧）' },
    { id: 'llama', name: '免费 Llama（额度收紧）' },
    { id: 'qwen-coder', name: '免费 Qwen Coder（额度收紧）' },
    { id: 'nova-fast', name: '免费 Nova Fast（可能繁忙）' }
  ],
  modelCount: 6,
  latencyMs: null,
  isFallback: true
};

function freeProvider() {
  return JSON.parse(JSON.stringify(FREE_TEMPLATE));
}

/** 该通道此刻能否直接推理 */
function canSpeak(p) {
  return !!(p && p.chatCapable && (p.status === 'online' || p.status === 'restricted'));
}

function isLocal(p) {
  const caps = p.caps || [];
  const id = String(p.id || '');
  return caps.includes('local') || caps.includes('offline') ||
    /^(ollama|lmstudio|jan|llamacpp|vllm|koboldcpp|gpt4all|dsh)$/.test(id) ||
    /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(String(p.endpoint || ''));
}

function isFree(p) {
  return (p.caps || []).includes('free') || p.id === FREE_ID;
}

/** 在线通道优先级：本地免费 > 免费云端 > 其它在线 > 聚合器 */
function score(p) {
  let s = p.latencyMs || 600;
  if (isLocal(p)) s -= 5000;
  if (isFree(p)) s -= 2000;
  if ((p.caps || []).includes('aggregator')) s += 60;
  return s;
}

/**
 * 把免费通道注入拓扑（设置里可关：freeFallback === false）。
 * 始终注入而非「仅无通道时」注入，这样用户随时能看到并手动选用免费模型；
 * 自动路由靠 score 保证本地/已配置通道优先。
 */
function inject(providers, settings) {
  const list = Array.isArray(providers) ? providers.slice() : [];
  if (settings && settings.freeFallback === false) return list;
  const idx = list.findIndex((p) => p.id === FREE_ID);
  const fp = freeProvider();
  if (idx >= 0) list[idx] = fp; else list.push(fp);
  return list;
}

/**
 * 为某个被请求的对象挑选「实际发言人」。
 * 返回 { provider, bridge } —— bridge 为 null 表示它自己发言。
 */
function pickSpeaker(providers, requestedId) {
  const pool = (Array.isArray(providers) ? providers : []).filter(canSpeak);
  const requested = pool.find((p) => p.id === requestedId);
  if (requested) return { provider: requested, bridge: null };
  if (!pool.length) return null;

  const speaker = pool.slice().sort((a, b) => score(a) - score(b))[0];
  let reason;
  if (requestedId === FREE_ID) reason = '免费通道暂不可用';
  else reason = '该节点无法直接推理，已自动切换';
  return {
    provider: speaker,
    bridge: {
      requestedId,
      requestedName: requestedId || '未选择通道',
      speakerId: speaker.id,
      speakerName: speaker.name,
      reason
    }
  };
}

/**
 * 发言人候选列表（按优先级排序），用于「首选返回空/报错」时依次回退。
 * 首个始终是被请求节点自己（若能推理），其后是免费通道与其余在线通道。
 */
function speakerCandidates(providers, requestedId) {
  const pool = (Array.isArray(providers) ? providers : []).filter(canSpeak);
  const requested = pool.find((p) => p.id === requestedId);
  const others = pool.filter((p) => p.id !== requestedId).sort((a, b) => score(a) - score(b));
  // 回退序列里把免费通道提到最前：免密钥、最稳定、不消耗额度
  const freeFirst = others.slice().sort((a, b) => {
    const fa = isFree(a) ? 0 : 1;
    const fb = isFree(b) ? 0 : 1;
    return fa - fb || score(a) - score(b);
  });
  const seq = requested ? [requested].concat(freeFirst) : freeFirst;
  // 去重
  const seen = new Set();
  return seq.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

module.exports = { FREE_ID, freeProvider, inject, pickSpeaker, speakerCandidates, canSpeak, isFree, isLocal, score };
