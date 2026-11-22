'use strict';
/**
 * 微信群聊式多人对话引擎（Group Chat Engine）
 * ------------------------------------------------------------
 * 用户抛出一个问题，系统按所选模式自动分配给多个 AI 并行/串行处理：
 *   broadcast —— 全员各自回答，同时开麦
 *   relay     —— 轮流接龙，后面的人看到前面的发言
 *   delegate  —— 主持 AI 拆任务 → 分派给成员 → 汇总成最终答案
 *
 * 本模块只做「编排 + 事件」，真正的推理仍走 providers.streamChat，
 * 因此自动享有此前的发言人桥接与空响应回退能力。
 */
const free = require('./free');

const MODES = ['broadcast', 'relay', 'delegate'];

function firstModel(p) {
  return (p.models && p.models[0] && p.models[0].id) || null;
}

/** 从一段可能带 markdown 的文本里抽出 JSON（主持人的任务分配单） */
function extractJson(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/**
 * 调一个成员说话（非流式收集全文，群聊里以「一条完整消息」呈现）。
 * opts.onDelta 可选，用于逐字预览。
 */
async function speak(provider, { messages, model, maxTokens, signal, onDelta, snapshot }) {
  const aborted = () => !!(signal && signal.aborted);
  const pool = (snapshot && Array.isArray(snapshot.providers) ? snapshot.providers : (Array.isArray(snapshot) ? snapshot : []));
  // 候选：被请求节点自己 → 同通道的其它模型 → 免费通道与其它在线通道
  const candidates = [];
  if (free.canSpeak(provider)) candidates.push({ provider, model: model || firstModel(provider), bridge: null });
  const picked = free.canSpeak(provider) ? null : free.pickSpeaker(pool, provider && provider.id);
  if (picked) candidates.push({ provider: picked.provider, model: firstModel(picked.provider), bridge: picked.bridge });

  let lastErr = null;
  for (const cand of candidates) {
    if (aborted()) break;
    let text = '';
    try {
      const result = await require('./providers').streamChat(cand.provider, {
        model: cand.model,
        messages,
        maxTokens: maxTokens || 700,
        signal,
        onDelta: (t) => { text += t; if (onDelta && !aborted()) onDelta(t); }
      });
      if (aborted()) break;
      if (!text) text = (result.text || result.reasoning || '').trim();
      if (!text) { lastErr = new Error('通道返回空响应'); continue; }
      return { text, model: result.model || cand.model, bridge: cand.bridge, speaker: cand.provider };
    } catch (err) {
      if (aborted()) break;
      lastErr = err;
    }
  }
  if (aborted()) {
    const e = new Error('已停止输出');
    e.code = 'aborted';
    throw e;
  }
  // 自己没说话成功，最后兜底：任选一个其它在线通道（免费优先）
  const fallback = free.pickSpeaker(pool, provider && provider.id);
  if (fallback && (!candidates.length || candidates[candidates.length - 1].provider.id !== fallback.provider.id)) {
    try {
      let text = '';
      const result = await require('./providers').streamChat(fallback.provider, {
        model: firstModel(fallback.provider), messages, maxTokens: maxTokens || 700, signal,
        onDelta: (t) => { text += t; if (onDelta && !aborted()) onDelta(t); }
      });
      if (aborted()) throw Object.assign(new Error('已停止输出'), { code: 'aborted' });
      if (!text) text = (result.text || result.reasoning || '').trim();
      if (text) return { text, model: result.model || firstModel(fallback.provider), bridge: fallback.bridge, speaker: fallback.provider };
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('没有可用发言通道');
}

/** 主持人 tasked 分配单 → 归一化成 [{memberId, task}] */
function normalizePlan(plan, members) {
  const ids = new Set(members.map((m) => m.id));
  const arr = Array.isArray(plan) ? plan
    : (Array.isArray(plan && plan.tasks) ? plan.tasks : []);
  const out = [];
  for (const item of arr) {
    const raw = String((item && (item.memberId || item.assignee || item.id || item.member)) || '').trim();
    const task = String((item && (item.task || item.subtask || item.prompt || item.description)) || '').trim();
    if (!task) continue;
    let memberId = members.find((m) => m.id === raw || m.name === raw)?.id;
    if (!memberId && /^\d+$/.test(raw)) {
      const idx = Number(raw) - 1;
      if (idx >= 0 && idx < members.length) memberId = members[idx].id;
    }
    if (!memberId || !ids.has(memberId)) memberId = members[out.length % members.length].id;
    out.push({ memberId, task });
  }
  return out;
}

async function run({ mode, question, members, snapshot, maxTokens, onEvent, signal }) {
  if (!MODES.includes(mode)) mode = 'broadcast';
  const aborted = () => !!(signal && signal.aborted);
  const emit = (type, payload) => onEvent && onEvent(Object.assign({ type }, payload));
  const say = (provider, opts) => speak(provider, Object.assign({}, opts, { snapshot }));

  if (!Array.isArray(members) || !members.length) {
    emit('error', { code: 'no_members', message: '请至少选择一位群成员' });
    return;
  }
  if (!question || !String(question).trim()) {
    emit('error', { code: 'no_question', message: '请输入问题' });
    return;
  }

  emit('group_start', { mode, question, members: members.map((m) => ({ id: m.id, name: m.name })) });

  if (mode === 'broadcast') {
    await Promise.all(members.map(async (m) => {
      const mid = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      emit('message_start', { mid, memberId: m.id, name: m.name });
      try {
        const r = await say(m, {
          messages: [{ role: 'system', content: '你是群聊中的一位 AI 成员。请直接、简洁地回答用户的问题，不超过 160 字。' }, { role: 'user', content: question }],
          maxTokens, signal
        });
        emit('message_done', { mid, memberId: m.id, name: m.name, text: r.text, model: r.model, bridge: r.bridge });
      } catch (err) {
        // 停止时不把「已取消」伪装成成员发言失败
        if (!aborted()) emit('message_error', { mid, memberId: m.id, name: m.name, message: err.message || '发言失败' });
      }
    }));
  } else if (mode === 'relay') {
    let transcript = '';
    for (const m of members) {
      if (signal && signal.aborted) break;
      const mid = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      emit('message_start', { mid, memberId: m.id, name: m.name });
      try {
        const r = await say(m, {
          messages: [
            { role: 'system', content: '你在参加一个多 AI 群聊。参考前面成员的发言，补充你的观点，不要重复别人说过的话。不超过 140 字。' },
            { role: 'user', content: `用户问题：${question}\n\n前面成员的发言：\n${transcript || '（你是第一位）'}` }
          ],
          maxTokens, signal
        });
        transcript += `${m.name}：${r.text}\n`;
        emit('message_done', { mid, memberId: m.id, name: m.name, text: r.text, model: r.model, bridge: r.bridge });
      } catch (err) {
        if (!aborted()) emit('message_error', { mid, memberId: m.id, name: m.name, message: err.message || '发言失败' });
      }
    }
  } else {
    /* delegate：主持 AI 拆任务 → 成员执行 → 主持汇总 */
    const host = members[0];
    const midHost = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    emit('message_start', { mid: midHost, memberId: host.id, name: host.name, role: 'host' });
    let planText = '';
    try {
      const roster = members.map((m, i) => `${i + 1}. ${m.name}`).join('\n');
      const planRes = await say(host, {
        messages: [
          { role: 'system', content: '你是群聊主持人。把用户的问题拆成若干子任务分派给成员。只输出 JSON：{"tasks":[{"assignee":"成员序号或名字","task":"子任务"}]}，不要多余文字。' },
          { role: 'user', content: `成员名单：\n${roster}\n\n问题：${question}` }
        ],
        maxTokens: 400, signal
      });
      planText = planRes.text;
    } catch (err) {
      if (!aborted()) emit('message_error', { mid: midHost, memberId: host.id, name: host.name, message: '主持人分派失败：' + err.message });
    }
    if (aborted()) { emit('stopped', { message: '已停止输出与思考' }); return; }
    const plan = extractJson(planText);
    const tasks = normalizePlan(plan, members);
    emit('message_done', {
      mid: midHost, memberId: host.id, name: host.name, role: 'host',
      text: tasks.length
        ? `收到，我把问题拆成 ${tasks.length} 份分派给各位：\n` + tasks.map((t, i) => `${i + 1}. ${members.find((m) => m.id === t.memberId)?.name || '成员'} → ${t.task}`).join('\n')
        : (planText || '我来直接回答这个问题。'),
      model: firstModel(host), bridge: null
    });

    const list = tasks.length ? tasks : members.map((m) => ({ memberId: m.id, task: question }));
    const results = await Promise.all(list.map(async ({ memberId, task }) => {
      const m = members.find((x) => x.id === memberId) || members[0];
      const mid = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      emit('message_start', { mid, memberId: m.id, name: m.name, role: 'member', task });
      try {
        const r = await say(m, {
          messages: [
            { role: 'system', content: '你是群聊成员。主持人给你分派了一个子任务，请针对它给出专业、简洁的结论（不超过 160 字），不必复述任务。' },
            { role: 'user', content: `总问题：${question}\n\n你的子任务：${task}` }
          ],
          maxTokens, signal
        });
        emit('message_done', { mid, memberId: m.id, name: m.name, role: 'member', task, text: r.text, model: r.model, bridge: r.bridge });
        return { name: m.name, task, text: r.text };
      } catch (err) {
        if (!aborted()) emit('message_error', { mid, memberId: m.id, name: m.name, message: err.message || '处理失败' });
        return null;
      }
    }));

    if (aborted()) { emit('stopped', { message: '已停止输出与思考' }); return; }
    const digest = results.filter(Boolean).map((r) => `${r.name}（${r.task}）：${r.text}`).join('\n\n');
    const midSum = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    emit('message_start', { mid: midSum, memberId: host.id, name: host.name, role: 'summary' });
    try {
      const r = await say(host, {
        messages: [
          { role: 'system', content: '你是群聊主持人。综合各位成员的发言，给出最终答案。结构化、简洁，不超过 300 字。' },
          { role: 'user', content: `用户问题：${question}\n\n成员发言：\n${digest || '（无人成功发言）'}` }
        ],
        maxTokens: (maxTokens || 700) + 300, signal
      });
      emit('message_done', { mid: midSum, memberId: host.id, name: host.name, role: 'summary', text: r.text, model: r.model, bridge: r.bridge });
    } catch (err) {
      if (!aborted()) emit('message_error', { mid: midSum, memberId: host.id, name: host.name, message: '汇总失败：' + err.message });
    }
  }

  if (aborted()) emit('stopped', { message: '已停止输出与思考' });
  else emit('group_done', {});
}

module.exports = { run, MODES, speak };
