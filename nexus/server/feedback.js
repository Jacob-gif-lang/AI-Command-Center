'use strict';
/**
 * 用户反馈中心 v0.7.2
 * - 四类反馈：功能建议 / 界面外观 / 体验问题 / 错误报告
 * - 功能投票：内置 + 用户提案，本机持久化票数与我的投票
 * - 优化建议：草稿保存、删除、标记已发送
 * - 环境信息：版本、平台、架构，随邮件一并发送
 */
const os = require('os');
const path = require('path');
const store = require('./store');

const FEEDBACK_EMAIL = 'tianjinkang0130@sina.com';

function appVersion() {
  try {
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    return pkg.version || '0.7.2';
  } catch { return '0.7.2'; }
}

const CATEGORIES = [
  { id: 'feature', label: '功能建议' },
  { id: 'appearance', label: '界面外观' },
  { id: 'ux', label: '体验问题' },
  { id: 'bug', label: '错误报告' }
];

function catLabel(id) {
  const c = CATEGORIES.find((x) => x.id === id);
  return c ? c.label : '功能建议';
}

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
    return { version: 1, ideas: JSON.parse(JSON.stringify(DEFAULT_IDEAS)), suggestions: [], mails: [], myVotes: {} };
  }
  return {
    version: data.version || 1,
    ideas: data.ideas,
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    mails: Array.isArray(data.mails) ? data.mails : [],
    myVotes: data.myVotes && typeof data.myVotes === 'object' ? data.myVotes : {}
  };
}

function save(data) {
  try { store.writeJson('feedback.json', data); } catch { /* ignore */ }
  return data;
}

function envInfo() {
  return {
    version: appVersion(),
    platform: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
    arch: process.arch || os.arch(),
    os: `${os.type()} ${os.release()}`,
    node: process.version
  };
}

function stats(data) {
  const ideas = data.ideas || [];
  return {
    ideas: ideas.length,
    votes: ideas.reduce((n, i) => n + (i.votes || 0), 0),
    suggestions: (data.suggestions || []).length,
    sent: (data.suggestions || []).filter((s) => s.sent).length
  };
}

function getFeedback() {
  const data = read();
  const env = envInfo();
  return {
    email: FEEDBACK_EMAIL,
    version: env.version,
    env,
    categories: CATEGORIES,
    stats: stats(data),
    myVotes: data.myVotes || {},
    ideas: data.ideas,
    suggestions: data.suggestions,
    mails: data.mails
  };
}

function vote(id, delta) {
  const data = read();
  const idea = data.ideas.find((i) => i.id === id);
  if (!idea) return null;
  const prev = data.myVotes[id] || 0;
  const dir = delta === -1 ? -1 : 1;
  if (dir > 0 && prev > 0) return { idea, unchanged: true };
  if (dir < 0 && prev <= 0) return { idea, unchanged: true };
  idea.votes = Math.max(0, (idea.votes || 0) + dir);
  data.myVotes[id] = dir > 0 ? 1 : 0;
  save(data);
  return { idea, unchanged: false };
}

function addIdea(title, category) {
  const data = read();
  const clean = String(title || '').trim().slice(0, 120);
  if (!clean) return null;
  const existing = data.ideas.find((i) => i.title.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const valid = CATEGORIES.some((c) => c.id === category) ? category : 'feature';
  const idea = {
    id: `idea-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    title: clean,
    category: valid,
    votes: 1,
    custom: true
  };
  data.ideas.push(idea);
  data.myVotes[idea.id] = 1;
  save(data);
  return idea;
}

function addSuggestion(payload) {
  const data = read();
  const text = String(payload && payload.text || '').trim().slice(0, 2000);
  if (!text) return null;
  const valid = CATEGORIES.some((c) => c.id === payload.category) ? payload.category : 'feature';
  const item = {
    id: `sg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    category: valid,
    text,
    contact: String(payload.contact || '').trim().slice(0, 120),
    createdAt: new Date().toISOString(),
    sent: false
  };
  data.suggestions.unshift(item);
  while (data.suggestions.length > 200) data.suggestions.pop();
  save(data);
  return item;
}

function removeSuggestion(id) {
  const data = read();
  const before = data.suggestions.length;
  data.suggestions = data.suggestions.filter((s) => s.id !== id);
  if (data.suggestions.length === before) return false;
  save(data);
  return true;
}

function markSent(payload) {
  const data = read();
  const ids = payload && Array.isArray(payload.ids) ? payload.ids : null;
  const all = !ids || ids.length === 0;
  let count = 0;
  data.suggestions.forEach((s) => {
    if (all || ids.includes(s.id)) { if (!s.sent) count += 1; s.sent = true; }
  });
  data.mails.unshift({ at: new Date().toISOString(), count, to: FEEDBACK_EMAIL });
  while (data.mails.length > 20) data.mails.pop();
  save(data);
  return { ok: true, count };
}

function buildMailBody() {
  const data = read();
  const env = envInfo();
  const lines = [];
  lines.push('NEXUS 用户反馈中心');
  lines.push(`时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`反馈邮箱：${FEEDBACK_EMAIL}`);
  lines.push(`软件版本：${env.version}　平台：${env.platform} (${env.arch})　系统：${env.os}`);
  lines.push('');
  lines.push('===== 功能投票（按票数排序） =====');
  const sorted = data.ideas.slice().sort((a, b) => (b.votes || 0) - (a.votes || 0));
  sorted.forEach((idea, idx) => {
    lines.push(`${idx + 1}. [${catLabel(idea.category)}] ${idea.title} —— ${idea.votes || 0} 票${idea.custom ? '（用户新增）' : ''}`);
  });
  lines.push('');
  lines.push('===== 优化建议 =====');
  if (!data.suggestions.length) lines.push('（暂无文字建议）');
  data.suggestions.forEach((s, idx) => {
    lines.push(`${idx + 1}. [${catLabel(s.category)}] ${s.text}${s.sent ? '（已发送）' : ''}`);
    if (s.contact) lines.push(`   联系方式：${s.contact}`);
  });
  lines.push('');
  lines.push('—— 由 NEXUS 用户反馈中心自动生成');
  return lines.join('\n');
}

function mailtoUrl(subject, body) {
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject || 'NEXUS 用户反馈')}&body=${encodeURIComponent(body || '')}`;
}

module.exports = {
  FEEDBACK_EMAIL,
  CATEGORIES,
  appVersion,
  envInfo,
  getFeedback,
  vote,
  addIdea,
  addSuggestion,
  removeSuggestion,
  markSent,
  buildMailBody,
  mailtoUrl
};
