'use strict';
/**
 * 推理调用适配层（Provider Adapter Layer）
 * ------------------------------------------------------------
 * 把 4 类异构后端统一成一条流：
 *   ollama      -> POST {base}/api/chat                        (NDJSON)
 *   openai      -> POST {base}/v1/chat/completions              (SSE)
 *   mcp / app   -> 不参与对话，只作为画布节点与工具源
 *   demo        -> 本地模拟，用于零可用后端时的演示与自测
 *
 * 所有适配器都遵守同一契约：
 *   streamChat(provider, opts) -> { text, usage, model }  并通过 onDelta 回调吐增量
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const CRED_PATH = path.join(HOME, '.dsh', '.credentials.yaml');

class ChatError extends Error {
  constructor(message, { code = 'upstream_error', status = 502, hint = '' } = {}) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

/* --------------------------------------------------------------- 凭据解析 */

const KEY_MAP = {
  'cloud:moonshot': ['MOONSHOTAI_API_KEY', 'MOONSHOT_API_KEY'],
  'cloud:deepseek': ['DEEPSEEK_API_KEY'],
  'cloud:teamo': ['TEAMO_API_KEY'],
  'cloud:openrouter': ['OPENROUTER_API_KEY']
};

function readYamlScalar(text, name) {
  const re = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'm');
  const m = re.exec(text || '');
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

function resolveApiKey(provider) {
  if (!provider) return null;

  /* 自定义接入：密钥存在本机 custom-providers.json，用时按 id 取回 */
  if (String(provider.id || '').startsWith('custom:')) {
    try {
      const record = require('./custom').rawList().find((p) => p.id === provider.id);
      if (record && record.apiKey) return record.apiKey;
    } catch { /* ignore */ }
    return null;
  }

  if (provider.id === 'dsh') {
    try {
      return fs.readFileSync(path.join(HOME, '.dsh', 'openai-gateway', 'api-key'), 'utf8').trim();
    } catch { return null; }
  }
  const names = KEY_MAP[provider.id];
  if (!names) return null;
  let text = '';
  try { text = fs.readFileSync(CRED_PATH, 'utf8'); } catch { return null; }
  for (const n of names) {
    const v = readYamlScalar(text, n);
    if (v) return v;
  }
  return null;
}

/* --------------------------------------------------------------- 工具函数 */

function joinBase(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!suffix) return b;
  // 若 base 已带 /v1，则避免重复拼接
  if (/\/v\d+(\.\d+)?$/.test(b) && suffix.startsWith('/v1/')) {
    return b + suffix.slice(3);
  }
  return b + suffix;
}

async function readErrorBody(res) {
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  const nested = json && (json.error || json);
  const message = (nested && (nested.message || nested.msg)) || text.slice(0, 300) || `HTTP ${res.status}`;
  const type = (nested && (nested.type || nested.code)) || '';
  return { message, type, text };
}

function classifyError(status, message, type) {
  const blob = `${type} ${message}`.toLowerCase();
  if (blob.includes('insufficient_balance') || blob.includes('insufficient balance') || blob.includes('余额不足')) {
    return new ChatError('上游通道余额不足', {
      code: 'insufficient_balance', status: 402,
      hint: '该通道的钱包已欠费，请到对应控制台充值，或用画布切换到其他 AI 节点。'
    });
  }
  if (status === 401 || status === 403 || blob.includes('unauthorized') || blob.includes('invalid api key')) {
    return new ChatError('凭据被拒绝', {
      code: 'unauthorized', status,
      hint: '本机保存的密钥可能已失效，请在原应用内重新登录或轮换密钥。'
    });
  }
  if (status === 429 || blob.includes('rate limit')) {
    return new ChatError('触发限流', { code: 'rate_limited', status, hint: '稍后重试，或在画布里提高并发间隔。' });
  }
  if (status === 404 || blob.includes('model_not_found') || blob.includes('does not exist')) {
    return new ChatError('模型或接口路径不存在', {
      code: 'model_not_found', status,
      hint: '当前通道里没有这个模型，或 API 地址缺少 /v1 路径。可在「接入」里刷新模型清单，或点「一键修复」。'
    });
  }
  if (blob.includes('context length') || blob.includes('too long') || blob.includes('maximum context')) {
    return new ChatError('上下文超出模型上限', {
      code: 'context_overflow', status,
      hint: '这条对话太长了。开新对话，或在画布里把长文本交给长上下文模型处理。'
    });
  }
  if (blob.includes('bun') || blob.includes('worker')) {
    return new ChatError('推理 worker 依赖缺失', {
      code: 'missing_runtime', status,
      hint: '该通道需要本机运行时（例如 Bun / Python worker），请按提示安装后重试。'
    });
  }
  if (status >= 500) {
    return new ChatError(message, { code: 'upstream_error', status, hint: '上游服务异常，可切换到其他 AI 节点。' });
  }
  return new ChatError(message, { code: 'request_failed', status: status || 400, hint: '' });
}

/* ----------------------------------------------------------- OpenAI / SSE */

async function streamOpenAI(provider, opts) {
  const { model, messages, maxTokens, onDelta, onThinking, signal } = opts;
  const apiKey = resolveApiKey(provider);
  const url = joinBase(provider.endpoint, '/v1/chat/completions');

  /**
   * 部分模型（如 kimi-k2.6）只接受固定的 temperature。
   * 因此默认不传，交给上游自己的默认值；只在调用方显式指定时才带上。
   * withThink 同理：仅当用户开启深度思考时附加 enable_thinking，
   * 不支持该参数的兼容服务会自动降级重试。
   */
  async function attempt(temperature, withThink) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const payload = { model, messages, stream: true, max_tokens: maxTokens || 2048 };
    if (typeof temperature === 'number') payload.temperature = temperature;
    if (withThink) payload.enable_thinking = true;

    const res = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(payload) });
    if (!res.ok) {
      const info = await readErrorBody(res);
      throw classifyError(res.status, info.message, info.type);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let usage = null;

    while (true) {
      if (signal && signal.aborted) throw new ChatError('已停止输出', { code: 'aborted', status: 499 });
      const { done, value } = await reader.read();
      if (done) break;
      if (signal && signal.aborted) throw new ChatError('已停止输出', { code: 'aborted', status: 499 });
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          if (chunk.usage) usage = chunk.usage;
          const d = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || {};
          // 思维链：兼容 DeepSeek 的 reasoning_content、通用 reasoning、
          // 以及部分兼容服务的 delta.thinking / 顶层 choices[0].delta.reasoning
          const c0 = chunk.choices && chunk.choices[0] || {};
          const think = d.reasoning_content || d.reasoning || d.thinking ||
            c0.reasoning_content || c0.reasoning || '';
          if (think) {
            reasoning += think;
            onThinking && onThinking(think);
          }
          const delta = d.content ||
            (chunk.choices && chunk.choices[0] && chunk.choices[0].message && chunk.choices[0].message.content) || '';
          if (delta) {
            text += delta;
            onDelta && onDelta(delta);
          }
        } catch { /* 跳过非法分片 */ }
      }
    }
    return { text, reasoning, usage, model };
  }

  const wantThink = opts.think === true;
  try {
    return await attempt(opts.temperature, wantThink);
  } catch (err) {
    const msg = err.message || '';
    // 上游不接受 enable_thinking（未知参数）→ 去掉思考参数重试，思维链仍可能被解析
    if (wantThink && /enable_thinking|unknown|unrecognized|unexpected|invalid.*parameter|additional.*propert/i.test(msg)) {
      return await attempt(opts.temperature, false);
    }
    // 上游抱怨 temperature 时，按它的要求退回固定值再试一次
    if (/temperature/i.test(msg)) {
      return await attempt(1, wantThink);
    }
    throw err;
  }
}

/* --------------------------------------------------------------- Ollama */

async function streamOllama(provider, { model, messages, temperature, maxTokens, numCtx, think, onDelta, onThinking, signal }) {
  const url = joinBase(provider.endpoint, '/api/chat');
  // 纯 CPU 机器上，思考链和超大上下文是两大性能杀手：
  //   - think:false 关掉 reasoning 模型（qwen3/qwen3.5 等）的思维链，实测提速 4 倍以上；
  //   - num_ctx 限制上下文窗口，避免默认 26 万 token 把内存吃满导致换页卡顿。
  // 两者都可由调用方覆盖（需要深度推理时传 think:true）。
  const payload = {
    model,
    messages,
    stream: true,
    options: {
      temperature: typeof temperature === 'number' ? temperature : 0.6,
      num_predict: maxTokens || 1024,
      num_ctx: numCtx || 4096
    }
  };
  if (think !== undefined) payload.think = !!think;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const info = await readErrorBody(res);
    throw classifyError(res.status, info.message, info.type);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';

  while (true) {
    if (signal && signal.aborted) throw new ChatError('已停止输出', { code: 'aborted', status: 499 });
    const { done, value } = await reader.read();
    if (done) break;
    if (signal && signal.aborted) throw new ChatError('已停止输出', { code: 'aborted', status: 499 });
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const chunk = JSON.parse(line);
        const msg = chunk.message || {};
        const thinkDelta = msg.thinking || chunk.thinking || '';
        if (thinkDelta) {
          reasoning += thinkDelta;
          onThinking && onThinking(thinkDelta);
        }
        const delta = msg.content || '';
        if (delta) {
          text += delta;
          onDelta && onDelta(delta);
        }
      } catch { /* ignore */ }
    }
  }
  return { text, reasoning, model };
}

/* ------------------------------------------------------------------ Demo */

async function streamDemo({ prompt, onDelta, onThinking, think, signal }) {
  const reasoning = think === true
    ? [
        '（演示思维链）先确认用户的问题：',
        `${String(prompt || '').slice(0, 60)}。`,
        '这个问题要展示「深度思考」，所以我把分析过程单独输出，',
        '再给出正式回答。真实模型会在这里给出完整的推理步骤。'
      ].join('')
    : '';
  let thought = '';
  for (const ch of reasoning) {
    if (signal && signal.aborted) break;
    thought += ch;
    onThinking && onThinking(ch);
    await new Promise((r) => setTimeout(r, 8));
  }

  const canned = [
    '（模拟通道）我是 NEXUS 内置的演示节点。',
    '当前画布与对话链路已经全部打通：',
    '消息从侧边输入框进入路由层，命中节点后回流传到渲染层，',
    'SSE 逐字推流、画布高亮、通话通道的语速控制都走同一套事件总线。',
    '接入真实 AI 只需在本机启动 Ollama 或任意 OpenAI 兼容服务，',
    'NEXUS 启动时会自动识别并把它们挂成新的节点。'
  ];
  const text = `${canned.join('')}\n\n你刚才问的是：「${String(prompt || '').slice(0, 60)}」`;
  let out = '';
  for (const ch of text) {
    if (signal && signal.aborted) break;
    out += ch;
    onDelta && onDelta(ch);
    await new Promise((r) => setTimeout(r, 14));
  }
  return { text: out, reasoning: thought, model: 'nexus-demo' };
}

/* --------------------------------------------------------------- 统一入口 */

async function streamChat(provider, opts) {
  const { messages = [], model, onDelta, signal } = opts;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  try {
    if (!provider || provider.id === 'demo') {
      return await streamDemo({
        prompt: lastUser ? lastUser.content : '',
        onDelta,
        onThinking: opts.onThinking,
        think: opts.think,
        signal
      });
    }
    if (!provider.chatCapable) {
      throw new ChatError('该节点不支持对话', {
        code: 'not_chat_capable', status: 400,
        hint: '应用 / MCP 节点只提供工具与编排能力，请在画布中把它作为工具节点使用。'
      });
    }
    if (provider.kind === 'ollama') {
      return await streamOllama(provider, Object.assign({}, opts, { model: model || (provider.models[0] && provider.models[0].id) }));
    }
    if (provider.kind === 'openai') {
      return await streamOpenAI(provider, Object.assign({}, opts, { model: model || (provider.models[0] && provider.models[0].id) }));
    }
    throw new ChatError(`未知的通道类型：${provider.kind}`, { code: 'unknown_kind', status: 400 });
  } catch (err) {
    // AbortError / 主动取消统一成业务错误码，避免上层误判成上游故障而触发自愈
    if (signal && signal.aborted) {
      throw new ChatError('已停止输出', { code: 'aborted', status: 499, hint: '' });
    }
    throw err;
  }
}

module.exports = { streamChat, resolveApiKey, ChatError, joinBase };
