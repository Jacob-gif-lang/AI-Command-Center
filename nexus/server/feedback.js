'use strict';
/**
 * 用户优化与功能投票：
 * - 功能投票：内置 + 用户提交的功能提案，本机持久化票数
 * - 优化建议：外观样貌 / 功能 两类建议
 * - 邮件汇总：把投票与建议整理成邮件正文，支持 SMTP 直发与 mailto 兜底
 */
const store = require('./store');

const FEEDBACK_EMAIL = 'tianjinkang0130@sina.com';

const DEFAULT_IDEAS = [
  { id: 'theme', title: '更多主题配色与界面美化', category: 'appearance', votes: 0 },
  { id: 'icons', title: '可自定义应用图标与图案样貌', category: 'appearance', votes: 0 },
  { id: 'layout', title: '侧栏与聊天区布局自由调整', category: 'appearance', votes: 0 },
  { id: 'voice', title: '更自然的语音播报与音色选择', category: 'feature', votes: 0 },
  { id: 'plugins', title: '增加更多可用插件', category: 'feature', votes: 0 },
  { id: 'export', title: '对话与群聊记录导出', category: 'feature', votes: 0 },
  { id: 'shortcut', title: '自定义快捷键', category: 'feature', votes: 0 },
  { id: 'cloudsync', title: '配置云端同步', category: 'feature', votes: 0 }
];

function read() {
  const data = store.readJson('feedback.json', null);
  if (!data || !Array.isArray(data.ideas)) {
    return { version: 1, ideas: JSON.parse(JSON.stringify(DEFAULT_IDEAS)), suggestions: [], mails: [] };
  }
  return {
    version: data.version || 1,
    ideas: data.ideas,
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    mails: Array.isArray(data.mails) ? data.mails : []
  };
}

function save(data) {
  try { store.writeJson('feedback.json', data); } catch { /* ignore */ }
  return data;
}

function getFeedback() {
  const data = read();
  return Object.assign({ email: FEEDBACK_EMAIL }, data);
}

function vote(id, delta) {
  const data = read();
  const idea = data.ideas.find((i) => i.id === id);
  if (!idea) return null;
  idea.votes = Math.max(0, (idea.votes || 0) + (delta === -1 ? -1 : 1));
  save(data);
  return idea;
}

function addIdea(title, category) {
  const data = read();
  const clean = String(title || '').trim().slice(0, 120);
  if (!clean) return null;
  const existing = data.ideas.find((i) => i.title.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const idea = {
    id: `idea-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    title: clean,
    category: category === 'appearance' ? 'appearance' : 'feature',
    votes: 1,
    custom: true
  };
  data.ideas.push(idea);
  save(data);
  return idea;
}

function addSuggestion(payload) {
  const data = read();
  const text = String(payload && payload.text || '').trim().slice(0, 2000);
  if (!text) return null;
  const item = {
    id: `sg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    category: payload.category === 'appearance' ? 'appearance' : 'feature',
    text,
    contact: String(payload.contact || '').trim().slice(0, 120),
    createdAt: new Date().toISOString(),
    sent: false
  };
  data.suggestions.unshift(item);
  while (data.suggestions.length > 100) data.suggestions.pop();
  save(data);
  return item;
}

function markSent(ids) {
  const data = read();
  const set = new Set(Array.isArray(ids) ? ids : []);
  data.suggestions.forEach((s) => { if (set.has(s.id)) s.sent = true; });
  data.mails.unshift({ at: new Date().toISOString(), count: set.size, to: FEEDBACK_EMAIL });
  while (data.mails.length > 20) data.mails.pop();
  save(data);
}

function buildMailBody() {
  const data = read();
  const lines = [];
  lines.push('NEXUS 用户优化与功能投票反馈');
  lines.push(`时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`反馈邮箱：${FEEDBACK_EMAIL}`);
  lines.push('');
  lines.push('===== 功能投票（按票数排序） =====');
  const sorted = data.ideas.slice().sort((a, b) => (b.votes || 0) - (a.votes || 0));
  sorted.forEach((idea, idx) => {
    lines.push(`${idx + 1}. [${idea.category === 'appearance' ? '外观样貌' : '功能'}] ${idea.title} —— ${idea.votes || 0} 票${idea.custom ? '（用户新增）' : ''}`);
  });
  lines.push('');
  lines.push('===== 优化建议 =====');
  if (!data.suggestions.length) lines.push('（暂无文字建议）');
  data.suggestions.forEach((s, idx) => {
    lines.push(`${idx + 1}. [${s.category === 'appearance' ? '外观样貌' : '功能'}] ${s.text}`);
    if (s.contact) lines.push(`   联系方式：${s.contact}`);
  });
  lines.push('');
  lines.push('—— 由 NEXUS 用户优化功能自动生成');
  return lines.join('\n');
}

function mailtoUrl(subject, body) {
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject || 'NEXUS 用户优化反馈')}&body=${encodeURIComponent(body || '')}`;
}

module.exports = {
  FEEDBACK_EMAIL,
  getFeedback,
  vote,
  addIdea,
  addSuggestion,
  markSent,
  buildMailBody,
  mailtoUrl
};
