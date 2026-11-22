(function () {
  'use strict';
  const API = window.NexusAPI;
  const $ = (s) => document.querySelector(s);

  const NAME_MAP = {
    'msedge.exe': 'Edge 浏览器',
    'chrome.exe': 'Chrome 浏览器',
    'firefox.exe': 'Firefox 浏览器',
    'WeChatAppEx.exe': '微信内置播放器',
    'Weixin.exe': '微信',
    'thunder.exe': '迅雷',
    'wps.exe': 'WPS',
    'spotify.exe': 'Spotify',
    'QQMusic.exe': 'QQ 音乐',
    'cloudmusic.exe': '网易云音乐',
    'NEXUS.exe': 'NEXUS'
  };
  function friendly(name) {
    return NAME_MAP[name] || (name || '未知程序').replace(/\.exe$/i, '');
  }

  let refreshTimer = null;

  async function refresh() {
    const desc = $('#audioNowDesc');
    const list = $('#audioSources');
    const btn = $('#audioToggleBtn');
    const btnText = $('#audioToggleText');
    const useIcon = btn && btn.querySelector('use');
    if (!desc || !list || !btn) return;

    let st;
    try { st = await API.audioStatus(); } catch { st = { ok: false, error: 'unreachable' }; }

    if (!st || st.ok === false || st.error) {
      desc.textContent = st && st.message
        ? st.message
        : '声音控制不可用（需要本机 Python 3 + pycaw）';
      list.innerHTML = '';
      btn.disabled = true;
      btnText.textContent = '不可用';
      return;
    }

    const sessions = st.sessions || [];
    const live = sessions.filter((s) => s.state === 1);
    const muted = !!st.muted;

    if (muted) {
      desc.textContent = '已静音 · 点击「恢复」让当前程序继续发声';
    } else if (live.length) {
      desc.textContent = `正在发声：${live.map((s) => friendly(s.name)).join('、')}`;
    } else {
      desc.textContent = '当前没有程序在播放声音';
    }

    btn.disabled = false;
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    btnText.textContent = muted ? '恢复' : '静音';
    if (useIcon) useIcon.setAttribute('href', muted ? '#i-mute' : '#i-volume');

    list.innerHTML = sessions.map((s) => {
      const liveNow = s.state === 1;
      const isMuted = !!s.muted;
      const badge = liveNow ? (isMuted ? '已静音' : '播放中') : '';
      return `<div class="audio-source">
        <span class="a-dot ${(liveNow && !isMuted) ? '' : 'is-muted'}"></span>
        <span class="a-name">${friendly(s.name)}</span>
        <span class="a-badge ${liveNow ? 'is-live' : ''}">${badge}</span>
      </div>`;
    }).join('');
  }

  async function toggle() {
    const btn = $('#audioToggleBtn');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
      const r = await API.audioToggle();
      if (r && r.ok === false && r.message) {
        window.NexusViews && window.NexusViews.toast(r.message, 'error');
      } else if (r && r.action === 'muted') {
        window.NexusViews && window.NexusViews.toast(`已静音 ${r.count} 个发声程序`, 'ok');
      } else if (r && r.action === 'unmuted') {
        window.NexusViews && window.NexusViews.toast(`已恢复 ${r.count} 个程序`, 'ok');
      } else if (r && r.action === 'none') {
        window.NexusViews && window.NexusViews.toast(r.message || '当前没有在播放的声音');
      }
    } catch {
      window.NexusViews && window.NexusViews.toast('声音切换失败', 'error');
    } finally {
      btn.disabled = false;
      refresh();
    }
  }

  function onShow() {
    refresh();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if ($('[data-view="settings"]') && $('[data-view="settings"]').classList.contains('is-active')) refresh();
    }, 5000);
  }

  window.NexusSound = { refresh, toggle, onShow };

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('#audioToggleBtn');
    if (btn) btn.addEventListener('click', toggle);
  });
  if (document.readyState !== 'loading') {
    const btn = $('#audioToggleBtn');
    if (btn) btn.addEventListener('click', toggle);
  }
})();
