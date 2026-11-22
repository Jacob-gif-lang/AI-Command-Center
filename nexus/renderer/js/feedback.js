'use strict';
/** 用户反馈中心 v0.7.2：四类反馈、投票防刷、建议草稿/删除、统计与环境信息 */
(function () {
  const API = window.NexusAPI;
  const $ = (s, root) => (root || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const t = (s) => (window.NexusI18n && window.NexusI18n.t ? window.NexusI18n.t(s) : s);
  const MAIL = 'tianjinkang0130@sina.com';
  const CATS = {
    feature: () => t('功能建议'),
    appearance: () => t('界面外观'),
    ux: () => t('体验问题'),
    bug: () => t('错误报告')
  };
  function catLabel(c) { return (CATS[c] || CATS.feature)(); }

  let data = null;
  let toast = () => {};

  function setToast(fn) { toast = fn; }
  function notify(msg) { toast && toast(t(msg)); }

  async function refresh() {
    if (!API) return;
    data = await API.getFeedback();
    renderStats();
    renderIdeas();
    renderSuggestions();
    const el = $('#feedbackEmail');
    if (el) el.textContent = data && data.email ? data.email : MAIL;
  }

  function renderStats() {
    const s = (data && data.stats) || {};
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v == null ? 0 : v; };
    set('#fbStatIdeas', s.ideas);
    set('#fbStatVotes', s.votes);
    set('#fbStatSuggestions', s.suggestions);
    set('#fbStatSent', s.sent);
    const env = data && data.env;
    const el = $('#feedbackEnv');
    if (el && env) {
      el.textContent = `v${env.version} · ${env.platform} ${env.arch} · ${env.os}`;
      el.setAttribute('data-i18n-skip', '');
    }
  }

  function renderIdeas() {
    const box = $('#ideaList');
    if (!box) return;
    const ideas = (data && data.ideas) || [];
    if (!ideas.length) {
      box.innerHTML = `<div class="fb-empty">${esc(t('暂无提案，先在下方提交你想到的功能吧。'))}</div>`;
      return;
    }
    const myVotes = (data && data.myVotes) || {};
    const sorted = ideas.slice().sort((a, b) => (b.votes || 0) - (a.votes || 0));
    box.innerHTML = sorted.map((idea, idx) => {
      const mine = myVotes[idea.id] === 1;
      return `
      <div class="idea-row${mine ? ' voted' : ''}" data-id="${esc(idea.id)}">
        <span class="idea-rank">${idx + 1}</span>
        <div class="idea-main">
          <div class="idea-title">${esc(idea.title)}${idea.custom ? `<span class="idea-tag">${esc(t('用户新增'))}</span>` : ''}</div>
          <div class="idea-cat">${catLabel(idea.category)}</div>
        </div>
        <div class="idea-votes">
          <button class="vote-btn${mine ? ' active' : ''}" data-act="up" data-tip="${esc(t('支持 +1'))}">▲</button>
          <b class="vote-count">${idea.votes || 0}</b>
          <button class="vote-btn" data-act="down" data-tip="${esc(t('撤回 -1'))}">▼</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderSuggestions() {
    const box = $('#suggestionHistory');
    if (!box) return;
    const list = (data && data.suggestions) || [];
    if (!list.length) {
      box.innerHTML = `<div class="fb-empty">${esc(t('你提交的外观/功能建议会显示在这里。'))}</div>`;
      return;
    }
    box.innerHTML = list.slice(0, 20).map((s) => `
      <div class="sg-row" data-id="${esc(s.id)}">
        <span class="sg-cat ${esc(s.category)}">${catLabel(s.category)}</span>
        <span class="sg-text">${esc(s.text)}</span>
        <span class="sg-status">${s.sent ? esc(t('已发送')) : esc(t('待发送'))}</span>
        <button class="sg-del" data-act="del" data-tip="${esc(t('删除'))}" title="${esc(t('删除'))}">×</button>
      </div>`).join('');
  }

  function bind() {
    const ideaList = $('#ideaList');
    if (ideaList) {
      ideaList.addEventListener('click', async (e) => {
        const btn = e.target.closest('.vote-btn');
        if (!btn) return;
        const row = btn.closest('.idea-row');
        const id = row && row.dataset.id;
        const delta = btn.dataset.act === 'up' ? 1 : -1;
        try {
          const res = await API.voteIdea(id, delta);
          if (res && res.unchanged) { notify(delta > 0 ? '你已经支持过这项提案' : '你还没有支持这项提案'); return; }
          const count = $('.vote-count', row);
          if (count && res && res.idea) count.textContent = res.idea.votes || 0;
          notify('投票已记录');
          await refresh();
        } catch (err) { notify('投票失败：' + err.message); }
      });
    }

    const ideaForm = $('#ideaForm');
    if (ideaForm) {
      ideaForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = $('#ideaTitle');
        const title = input.value.trim();
        const category = $('#ideaCategory').value;
        if (!title) { notify('请填写功能名称'); return; }
        try {
          await API.addIdea(title, category);
          input.value = '';
          notify('功能提案已加入投票');
          await refresh();
        } catch (err) { notify('提交失败：' + err.message); }
      });
    }

    const sgForm = $('#suggestionForm');
    if (sgForm) {
      sgForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const textEl = $('#suggestionText');
        const contactEl = $('#suggestionContact');
        const text = textEl.value.trim();
        const category = $('#suggestionCategory').value;
        const contact = contactEl.value.trim();
        if (!text) { notify('请填写建议内容'); return; }
        try {
          await API.addSuggestion({ text, category, contact });
          textEl.value = '';
          contactEl.value = '';
          notify('建议已保存，可点「发送到邮箱」提交给团队');
          await refresh();
        } catch (err) { notify('保存失败：' + err.message); }
      });
    }

    const history = $('#suggestionHistory');
    if (history) {
      history.addEventListener('click', async (e) => {
        const btn = e.target.closest('.sg-del');
        if (!btn) return;
        const row = btn.closest('.sg-row');
        if (!row || !window.confirm(t('确认删除这条建议？'))) return;
        try {
          await API.deleteSuggestion(row.dataset.id);
          notify('已删除建议');
          await refresh();
        } catch (err) { notify('删除失败：' + err.message); }
      });
    }

    const markBtn = $('#feedbackMarkSentBtn');
    if (markBtn) {
      markBtn.addEventListener('click', async () => {
        try {
          const res = await API.markFeedbackSent({});
          notify('已标记 ' + (res.count || 0) + ' 条建议为已发送');
          await refresh();
        } catch (err) { notify('操作失败：' + err.message); }
      });
    }

    const sendBtn = $('#feedbackSendBtn');
    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = true;
        const old = sendBtn.textContent;
        sendBtn.textContent = t('正在提交…');
        try {
          const res = await API.sendFeedback({});
          if (res.ok && res.method === 'smtp') {
            notify('已发送到 ' + res.to);
            await API.markFeedbackSent({}).catch(() => {});
            await refresh();
          } else {
            const url = res.mailto || (await API.getMailto()).url;
            window.open(url, '_self');
            notify('已打开邮件客户端，收件人：' + (res.to || MAIL));
          }
        } catch (err) {
          notify('发送失败：' + err.message);
        } finally {
          sendBtn.disabled = false;
          sendBtn.textContent = old;
        }
      });
    }

    const copyBtn = $('#feedbackCopyBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          const res = await API.getMailto();
          const body = decodeURIComponent((res.url || '').split('&body=')[1] || '');
          if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(body);
          notify('反馈内容已复制，可手动粘贴到邮件');
        } catch (err) { notify('复制失败：' + err.message); }
      });
    }
  }

  function onShow() { refresh(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.NexusFeedback = { onShow, refresh, setToast, MAIL };
})();
