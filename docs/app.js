(function () {
  'use strict';

  // 移动端菜单
  var toggle = document.getElementById('navToggle');
  var nav = document.getElementById('siteNav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // 复制命令
  var copyButtons = document.querySelectorAll('.copy-btn');
  copyButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      var done = function () {
        var old = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = old; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else {
        fallback();
      }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (err) { /* ignore */ }
        document.body.removeChild(ta);
      }
    });
  });

  // 滚动淡入
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    reveals.forEach(function (el) { observer.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('visible'); });
  }
})();
