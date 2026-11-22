'use strict';
/**
 * 自定义接入层（User-supplied Endpoints）
 * ------------------------------------------------------------
 * 用户手动填写的「API 地址 + 密钥 + 模型」在这里统一管理：
 *   1. 落盘   —— %APPDATA%\Nexus\custom-providers.json
 *   2. 握手   —— 拉取 /models 确认地址、密钥、模型可用
 *   3. 注册   —— 转成标准 Provider 描述，混入探测快照，参与路由与画布
 *
 * 安全约定：
 *   - 密钥只写本机这一个文件，不外传、不进日志、不回传给渲染层；
 *   - 渲染层拿到的永远是掩码串；
 *   - 更新时若 apiKey 留空，表示沿用旧密钥。
 */
const crypto = require('node:crypto');
const store = require('./store');
const { probe, pickModels, normalizeBase, modelListUrl, maskKey } = require('./probe');

function newId() {
  return `custom:${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * 握手一个 OpenAI 兼容端点：拉模型清单。
 * @returns {{ok:boolean,status:number,latencyMs:number,models:Array,message:string}}
 */
async function handshake({ baseUrl, apiKey, kind = 'openai', listPath }) {
  const base = normalizeBase(baseUrl);
  if (!base) {
    return { ok: false, status: 0, latencyMs: 0, models: [], message: '缺少 API 地址' };
  }

  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // Ollama 用 /api/tags，其余走 OpenAI 兼容的 /v1/models
  const path = listPath || (kind === 'ollama' ? '/api/tags' : '/models');
  const url = modelListUrl(base, path);

  const res = await probe(url, { headers, timeout: 6000 });

  if (!res.ok) {
    let message = res.status ? `HTTP ${res.status}` : (res.error || '无法连接');
    const body = res.json && (res.json.error || res.json.message);
    if (body) message += ` · ${String(body.message || body).slice(0, 160)}`;
    return { ok: false, status: res.status, latencyMs: res.latency, models: [], message };
  }

  let models = pickModels(res.json);
  if (kind === 'ollama' && res.json && Array.isArray(res.json.models)) {
    models = res.json.models.map((m) => ({ id: m.name || m.model, name: m.name || m.model }));
  }
  return {
    ok: true,
    status: res.status,
    latencyMs: res.latency,
    models,
    message: models.length ? `握手成功 · ${models.length} 个模型` : '握手成功，但上游未返回模型清单'
  };
}

/** 校验并规范化一条自定义通道的输入 */
function normalizeInput(input = {}) {
  const name = String(input.name || '').trim();
  const baseUrl = normalizeBase(input.baseUrl || input.base || '');
  const kind = input.kind === 'ollama' ? 'ollama' : 'openai';
  const listPath = input.listPath || (kind === 'ollama' ? '/api/tags' : '/models');
  if (!name) return { error: '请填写名称' };
  if (!baseUrl) return { error: '请填写 API 地址' };
  if (!/^https?:\/\//i.test(baseUrl)) return { error: 'API 地址必须以 http:// 或 https:// 开头' };
  return {
    name,
    baseUrl,
    kind,
    listPath,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '',
    models: Array.isArray(input.models) ? input.models : [],
    modelId: input.modelId || null
  };
}

/** 新增一条自定义通道（保存前先握手验证） */
async function create(input) {
  const norm = normalizeInput(input);
  if (norm.error) return { ok: false, error: norm.error };

  const list = store.getCustomProviders();
  if (list.some((p) => p.name === norm.name)) {
    return { ok: false, error: `已存在同名通道「${norm.name}」` };
  }

  const probeResult = await handshake(norm);
  const now = new Date().toISOString();
  const record = {
    id: newId(),
    name: norm.name,
    kind: norm.kind,
    baseUrl: norm.baseUrl,
    listPath: norm.listPath,
    apiKey: norm.apiKey,
    models: probeResult.models.length ? probeResult.models : norm.models,
    modelId: norm.modelId || (probeResult.models[0] && probeResult.models[0].id) || null,
    lastProbe: {
      at: now,
      ok: probeResult.ok,
      status: probeResult.status,
      latencyMs: probeResult.latencyMs,
      message: probeResult.message
    },
    createdAt: now,
    updatedAt: now
  };
  list.push(record);
  store.saveCustomProviders(list);
  return { ok: true, provider: store.publicCustomProvider(record), probe: probeResult };
}

/** 更新一条自定义通道；apiKey 传空表示沿用旧值 */
async function update(id, patch = {}) {
  const list = store.getCustomProviders();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, error: '未找到该通道' };

  const old = list[idx];
  const merged = {
    name: patch.name !== undefined ? patch.name : old.name,
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : old.baseUrl,
    kind: patch.kind !== undefined ? patch.kind : old.kind,
    listPath: patch.listPath !== undefined ? patch.listPath : old.listPath,
    apiKey: typeof patch.apiKey === 'string' && patch.apiKey.trim() ? patch.apiKey.trim() : old.apiKey,
    models: Array.isArray(patch.models) ? patch.models : old.models,
    modelId: patch.modelId !== undefined ? patch.modelId : old.modelId
  };
  const norm = normalizeInput(merged);
  if (norm.error) return { ok: false, error: norm.error };

  const probeResult = await handshake(norm);
  const now = new Date().toISOString();
  const record = Object.assign({}, old, {
    name: norm.name,
    baseUrl: norm.baseUrl,
    kind: norm.kind,
    listPath: norm.listPath,
    apiKey: norm.apiKey,
    models: probeResult.models.length ? probeResult.models : norm.models,
    modelId: norm.modelId || (probeResult.models[0] && probeResult.models[0].id) || null,
    lastProbe: {
      at: now, ok: probeResult.ok, status: probeResult.status,
      latencyMs: probeResult.latencyMs, message: probeResult.message
    },
    updatedAt: now
  });
  list[idx] = record;
  store.saveCustomProviders(list);
  return { ok: true, provider: store.publicCustomProvider(record), probe: probeResult };
}

/** 重新拉取模型清单（不改动地址与密钥） */
async function refreshModels(id) {
  const list = store.getCustomProviders();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, error: '未找到该通道' };
  const p = list[idx];
  const probeResult = await handshake(p);
  if (probeResult.ok && probeResult.models.length) {
    p.models = probeResult.models;
    p.modelId = p.modelId && p.models.some((m) => m.id === p.modelId)
      ? p.modelId
      : p.models[0].id;
    p.updatedAt = new Date().toISOString();
    p.lastProbe = {
      at: p.updatedAt, ok: true, status: probeResult.status,
      latencyMs: probeResult.latencyMs, message: probeResult.message
    };
    list[idx] = p;
    store.saveCustomProviders(list);
  }
  return { ok: true, provider: store.publicCustomProvider(p), probe: probeResult };
}

function remove(id) {
  const list = store.getCustomProviders();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return { ok: false, error: '未找到该通道' };
  store.saveCustomProviders(next);
  return { ok: true, removed: id };
}

function listAll() {
  return store.getCustomProviders().map(store.publicCustomProvider);
}

/** 内部使用：拿带明文密钥的原始记录 */
function rawList() {
  return store.getCustomProviders();
}

/**
 * 转成标准 Provider 描述，混入探测快照。
 * 这里不做握手（握手在 detect 时统一做），只负责形状对齐。
 */
function toProvider(record, probeResult) {
  const online = !!(probeResult && probeResult.ok);
  return {
    id: record.id,
    name: record.name,
    vendor: '自定义接入',
    kind: record.kind === 'ollama' ? 'ollama' : 'openai',
    endpoint: record.baseUrl,
    status: online ? 'online' : (probeResult && probeResult.status ? 'restricted' : 'offline'),
    caps: ['chat', 'custom', 'user-added'],
    source: 'custom',
    detail: online
      ? `已接入 · ${(probeResult.models || []).length} 个模型`
      : `握手失败 · ${(probeResult && probeResult.message) || '未知原因'}`,
    models: (probeResult && probeResult.models) || record.models || [],
    modelCount: ((probeResult && probeResult.models) || record.models || []).length,
    latencyMs: (probeResult && probeResult.latencyMs) || 0,
    chatCapable: true,
    requiresKey: !!record.apiKey,
    keyHint: maskKey(record.apiKey),
    meta: { modelId: record.modelId, listPath: record.listPath }
  };
}

module.exports = {
  create, update, remove, refreshModels, listAll, rawList, handshake, toProvider, normalizeInput
};
