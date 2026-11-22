'use strict';
/**
 * HTTP 探测原语（被 detector / custom / repair 共用）
 * ------------------------------------------------------------
 * 独立成模块是为了避免 detector.js 与 custom.js 互相 require 造成循环依赖。
 */

const DEFAULT_TIMEOUT = 1600;

async function probe(url, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, headers = {}, method = 'GET', body = null } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return {
      ok: res.ok,
      status: res.status,
      latency: Date.now() - t0,
      json,
      snippet: text.slice(0, 300)
    };
  } catch (err) {
    const cause = (err && err.cause && (err.cause.code || err.cause.message)) || '';
    const message = err && err.name === 'AbortError'
      ? 'timeout'
      : cause === 'ECONNREFUSED' ? '端口未监听'
        : cause === 'ENOTFOUND' ? 'DNS 解析失败'
          : cause === 'ECONNRESET' ? '连接被重置'
            : String((err && err.message) || err) + (cause ? ` (${cause})` : '');
    return { ok: false, status: 0, latency: Date.now() - t0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** 从各种形状的响应里挑出模型清单 */
function pickModels(json) {
  if (!json) return [];
  const bag =
    json.data || json.models || json.entries ||
    (json.result && json.result.models) ||
    (Array.isArray(json) ? json : null);
  if (!Array.isArray(bag)) return [];
  return bag
    .map((m) => {
      if (typeof m === 'string') return { id: m, name: m };
      const id = m.id || m.name || m.model || m.slug || m.key;
      if (!id) return null;
      const ctx = m.context_length || m.contextLength || m.context_window || m.max_context_length;
      return {
        id: String(id),
        name: String(m.name || m.display_name || id),
        contextWindow: typeof ctx === 'number' ? ctx : undefined
      };
    })
    .filter(Boolean);
}

/** 归一化 base：去掉尾部斜杠，补齐缺失的 /v1（除非用户明确要根路径） */
function normalizeBase(raw) {
  let base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base;
}

/** 在 base 后拼接模型清单路径，兼容 base 已含 /v1 的情况 */
function modelListUrl(base, listPath) {
  const b = normalizeBase(base);
  const p = listPath || '/models';
  if (/\/v\d+(\.\d+)?$/.test(b) && /^\/v\d+\//.test(p)) return b + p.slice(p.indexOf('/', 1));
  return b + (p.startsWith('/') ? p : '/' + p);
}

/** 掩码密钥：只显示首尾各若干位 */
function maskKey(key) {
  const k = String(key || '');
  if (!k) return null;
  if (k.length <= 10) return k.slice(0, 2) + '***';
  return `${k.slice(0, 5)}***${k.slice(-4)}`;
}

module.exports = { probe, pickModels, normalizeBase, modelListUrl, maskKey, DEFAULT_TIMEOUT };
