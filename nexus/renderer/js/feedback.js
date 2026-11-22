'use strict';
/** 用户优化 · 功能投票：外观/功能建议、功能提案投票、发送到专用邮箱 */
(function () {
  const API = window.NexusAPI;
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAIL = 'tianjinkang0130@sina.com';

  let data = null;
  let toast = () => {};

  function setToast(fn) { toast = fn; }

  function catLabel(c) { return c === 'appearance' ? '外观样貌' : '功能'; }

  async function refresh() {
    if (!API) return;
    data = await API.getFeedback();
    renderIdeas();
    renderSuggestions();
    renderMeta();
  }

  function renderMeta() {
    const el = $('#feedbackEmail');
    if (el) el.textContent = data && data.email ? data.email : MAIL;
  }

  function renderIdeas() {
    const box = $('#ideaList');
    if (!box) return;
    const ideas = (data && data.ideas) || [];
    if (!ideas.length) {
      box.innerHTML = '<div class="fb-empty">暂无提案，先在下方提交你想到的功能吧。</div>';
      return;
    }
    const sorted = ideas.slice().sort((a, b) => (b.votes || 0) - (a.votes || 0));
    box.innerHTML = sorted.map((idea, idx) => `
      <div class="idea-row" data-id="${esc(idea.id)}">
        <span class="idea-rank">${idx + 1}</span>
        <div class="idea-main">
          <div class="idea-title">${esc(idea.title)}${idea.custom ? '<span class="idea-tag">用户新增</span>' : ''}</div>
          <div class="idea-cat">${catLabel(idea.category)}</div>
        </div>
        <div class="idea-votes">
          <button class="vote-btn" data-act="up" data-tip="支持 +1">▲</button>
          <b class="vote-count">${idea.votes || 0}</b>
          <button class="vote-btn" data-act="down" data-tip="撤回 -1">▼</button>
        </div>
      </div>`).join('');
  }

  function renderSuggestions() {
    const box = $('#suggestionHistory');
    if (!box) return;
    const list = (data && data.suggestions) || [];
    if (!list.length) {
      box.innerHTML = '<div class="fb-empty">你提交的外观/功能建议会显示在这里。</div>';
      return;
    }
    box.innerHTML = list.slice(0, 12).map((s) => `
      <div class="sg-row">
        <span class="sg-cat ${esc(s.category)}">${catLabel(s.category)}</span>
        <span class="sg-text">${esc(s.text)}</span>
        <span class="sg-status">${s.sent ? '已发送' : '待发送'}</span>
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
          const count = $('.vote-count', row);
          if (count && res && res.idea) count.textContent = res.idea.votes || 0;
          toast && toast('投票已记录');
          await refresh();
        } catch (err) { toast && toast('投票失败：' + err.message); }
      });
    }

    const ideaForm = $('#ideaForm');
    if (ideaForm) {
      ideaForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = $('#ideaTitle').value.trim();
        const category = $('#ideaCategory').value;
        if (!title) { toast && toast('请填写功能名称'); return; }
        try {
          await API.addIdea(title, category);
          $('#ideaTitle').value = '';
          toast && toast('功能提案已加入投票');
          await refresh();
        } catch (err) { toast && toast('提交失败：' + err.message); }
      });
    }

    const sgForm = $('#suggestionForm');
    if (sgForm) {
      sgForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = $('#suggestionText').value.trim();
        const category = $('#suggestionCategory').value;
        const contact = $('#suggestionContact').value.trim();
        if (!text) { toast && toast('请填写建议内容'); return; }
        try {
          await API.addSuggestion({ text, category, contact });
          $('#suggestionText').value = '';
          $('#suggestionContact').value = '';
          toast && toast('建议已保存，可点「发送到邮箱」提交给团队');
          await refresh();
        } catch (err) { toast && toast('保存失败：' + err.message); }
      });
    }

    const sendBtn = $('#feedbackSendBtn');
    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = true;
        const old = sendBtn.textContent;
        sendBtn.textContent = '正在提交…';
        try {
          const res = await API.sendFeedback({});
          if (res.ok && res.method === 'smtp') {
            toast && toast('已发送到 ' + res.to);
          } else {
            const url = res.mailto || (await API.getMailto()).url;
            window.open(url, '_self');
            toast && toast('已打开邮件客户端，收件人：' + (res.to || MAIL));
          }
        } catch (err) {
          toast && toast('发送失败：' + err.message);
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
          toast && toast('反馈内容已复制，可手动粘贴到邮件');
        } catch (err) { toast && toast('复制失败：' + err.message); }
      });
    }
  }

  function onShow() { refresh(); }

  window.NexusFeedback = { onShow, refresh, setToast, MAIL };
})();
