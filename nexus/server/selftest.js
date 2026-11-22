'use strict';
/** 自检：模块可加载、探测可执行、服务可起 */
const detector = require('./detector');
const providers = require('./providers');
const store = require('./store');

(async () => {
  console.log('[1/3] 模块加载 OK');
  const snap = await detector.detect();
  console.log(`[2/3] 探测 OK：${snap.summary.total} 对象 / ${snap.summary.online} 在线 / ${snap.summary.chatReady} 可对话 / ${snap.elapsedMs}ms`);
  for (const p of snap.providers) {
    console.log(`   - ${p.id.padEnd(30)} ${p.status.padEnd(11)} ${(p.detail || '').slice(0, 46)}`);
  }
  const s = store.getSettings();
  console.log(`[3/3] 配置 OK：dataDir=${store.ROOT}`);
  void providers;
})().catch((e) => { console.error('自检失败：', e); process.exit(1); });
