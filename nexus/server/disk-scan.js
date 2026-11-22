'use strict';
/**
 * 磁盘模型扫描层（Disk Model Scanner）
 * ------------------------------------------------------------
 * 背景：只扫 HTTP 端口会漏掉大量"安装了但运行时没启动"的模型，
 * 例如 Ollama 通过 OLLAMA_MODELS 把模型重定向到其它盘、独立的 GGUF 文件、
 * LM Studio / HuggingFace 缓存等。本模块直接读磁盘，把"躺在硬盘上的模型"找出来。
 *
 * 设计原则：
 *   1. 只读不写、不执行任何模型/脚本，绝不修改用户文件；
 *   2. 有深度/时间/条目上限，避免全盘遍历卡死 UI；
 *   3. 结果归一化为 provider（kind=local-file / ollama-disk），
 *      status=installed（在盘但服务未启动），不冒充在线可对话通道；
 *   4. quick 模式只扫高概率目录（默认每次探测都跑），deep 模式才做全盘。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

const GB = 1024 * 1024 * 1024;

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function stat(p) { try { return fs.statSync(p); } catch { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/* -------------------------------------------------- Ollama 磁盘模型 */

/** Ollama 可能的模型根目录：环境变量优先，再补默认与常见重定向 */
function ollamaModelRoots() {
  const roots = [];
  const push = (p) => { if (p && exists(p) && !roots.includes(p)) roots.push(p); };
  // 1) 关键：尊重运行时真正使用的环境变量（用户把模型放到了 D 盘）
  push(process.env.OLLAMA_MODELS);
  // 2) 默认位置
  push(path.join(HOME, '.ollama', 'models'));
  if (process.platform === 'win32') {
    push(path.join(LOCALAPPDATA, 'Ollama', 'models'));
    push(path.join(APPDATA, 'Ollama', 'models'));
  } else {
    push(path.join(HOME, '.local', 'share', 'ollama', 'models'));
  }
  // 3) 常见用户自定义重定向（扫描各盘根的 Ollama/models 目录）
  try {
    const drives = driveRoots();
    for (const d of drives) {
      push(path.join(d, 'Ollama', 'models'));
      push(path.join(d, 'ollama', 'models'));
    }
  } catch { /* ignore */ }
  return roots;
}

/** 解析 Ollama manifest：registry.ollama.ai/library/<name>/<tag> 或 manifests-v2/ollama.com/... */
function scanOllamaManifests(root) {
  const models = [];
  const seen = new Set();
  const manifestDirs = [
    path.join(root, 'manifests'),
    path.join(root, 'manifests-v2')
  ];
  const blobDir = path.join(root, 'blobs');

  for (const mdir of manifestDirs) {
    if (!exists(mdir)) continue;
    // 递归找所有 manifest 文件（层级：registry/namespace/name/tag）
    walk(mdir, { maxDepth: 6, onFile: (file) => {
      const rel = path.relative(mdir, file).replace(/\\/g, '/');
      const parts = rel.split('/');
      if (parts.length < 2) return; // 至少 name/tag
      const tag = parts[parts.length - 1];
      const name = parts[parts.length - 2];
      const family = parts.length >= 3 ? parts[parts.length - 3] : '';
      const id = `${name}:${tag}`;
      if (seen.has(id)) return;
      seen.add(id);

      const manifest = readJson(file);
      let sizeGB = 0;
      let params = '';
      let familyHint = family && family !== 'library' && family !== 'ollama.com' ? family : '';
      if (manifest) {
        // manifest.config 指向配置 blob，里面有模型参数量；layers 之和是体积
        const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
        const bytes = layers.reduce((n, l) => n + (Number(l.size) || 0), 0);
        sizeGB = Math.round((bytes / GB) * 10) / 10;
        const cfgDigest = manifest.config && manifest.config.digest;
        if (cfgDigest) {
          const cfgFile = path.join(blobDir, String(cfgDigest).replace(':', '-'));
          const cfg = readJson(cfgFile);
          if (cfg) {
            const p = cfg.model_parameters || cfg.parameters || '';
            if (p) params = String(p);
          }
        }
      }
      // 若 manifest 没给体积，尝试按 known blob 估算（保守：不虚报）
      const speedTier = sizeGB <= 0 ? 'unknown' : (sizeGB <= 3.5 ? 'fast' : (sizeGB <= 9 ? 'medium' : 'slow'));
      models.push({
        id,
        name: id,
        sizeGB,
        params,
        family: familyHint,
        speedTier,
        thinking: /qwen3|deepseek-r1|reasoner|think/i.test(id),
        manifestPath: file,
        source: 'ollama-disk'
      });
    }});
  }
  return models;
}

/* -------------------------------------------------- 通用模型文件扫描 */

const MODEL_EXT = /\.(gguf|ggml|safetensors|mlc|llamacpp)$/i; // 只认高置信扩展名；.bin/.onnx 误报太多，单独处理
const AMBIG_EXT = /\.(bin|onnx|pt|pth|ckpt)$/i;                 // 需要体积+路径双重验证
const SKIP_DIR = /^(node_modules|\.git|\.cache-tmp|Temp|tmp|Windows|System32|WinSxS|__pycache__|\.venv|site-packages|WeChat Files|WeChat|WeCom|sogou|SogouInput|Steam|steamapps|resources|app\.asar\.unpacked|locales|swiftshader)$/i;
// 这些文件名是 Electron / 输入法 / 游戏的数据文件，不是语言模型
const NOT_MODEL = /^(snapshot_blob|v8_context_snapshot|natives_blob|sgim_[\w]+|defaultskin|menu_cfg|policy_cfg|sdk_cfg|feature_config|kaomoji_sugg|UserGameStats[\w_]*|log|backup_drivers|RadiumWMPF|WeChatOcr|WeChatPlayer|WeChatUtility|XEditor|hashcat|d0ggle|Split|sysmodel|quantizer_decoder)$/i;

/** 从文件路径推断一个可读模型名 */
function nameFromModelFile(file) {
  let base = path.basename(file).replace(/\.(gguf|ggml|safetensors|bin|onnx|pt|pth|ckpt|mlc|llamacpp)$/i, '');
  base = base.replace(/[-_]?[Qq]\d[_ -]?[Kk]$/, '') // Q4_K_M 之类量化后缀
             .replace(/[-_]?fp16$/, '');
  return base || path.basename(file);
}

/** 模型文件体积分级 */
function fileTier(gb) {
  if (!gb || gb <= 0) return 'unknown';
  return gb <= 3.5 ? 'fast' : (gb <= 9 ? 'medium' : 'slow');
}

const MIN_AMBIG_BYTES = 50 * 1024 * 1024; // 模糊扩展名至少 50MB 才可能是模型


/* -------------------------------------------------- 遍历工具（带上限） */

function driveRoots() {
  const out = [];
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) { // C: .. Z:
      const d = String.fromCharCode(c) + ':\\';
      if (exists(d)) out.push(d);
    }
  } else {
    if (exists('/')) out.push('/');
  }
  return out;
}

/**
 * 有限深度遍历目录。
 * opts: { maxDepth, maxDirs, deadline, skip, onFile(file), onDir(dir) }
 */
function walk(root, opts = {}) {
  const maxDepth = opts.maxDepth != null ? opts.maxDepth : 3;
  const maxDirs = opts.maxDirs != null ? opts.maxDirs : 800;
  const deadline = opts.deadline || (Date.now() + 8000);
  let dirs = 0;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    if (Date.now() > deadline || dirs >= maxDirs) break;
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    dirs++;
    for (const e of entries) {
      if (opts.skip && opts.skip.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() && opts.onFile) {
        opts.onFile(full, e);
      }
    }
    if (opts.onDir) opts.onDir(dir);
  }
  return dirs;
}

/* -------------------------------------------------- 各运行时缓存目录 */

function extraModelDirs() {
  const dirs = [];
  const push = (p) => { if (p && exists(p) && !dirs.includes(p)) dirs.push(p); };
  // LM Studio
  push(path.join(HOME, '.cache', 'lm-studio', 'models'));
  push(path.join(LOCALAPPDATA, 'LM Studio', 'models'));
  push(path.join(HOME, 'LM Studio', 'models'));
  // HuggingFace 缓存（只取 hub 一层，里面是 models--xxx 快照）
  push(path.join(HOME, '.cache', 'huggingface', 'hub'));
  // 用户常见模型目录
  for (const d of ['Downloads', 'Documents', 'Desktop']) {
    const base = path.join(HOME, d);
    for (const sub of ['models', 'Models', 'gguf', 'GGUF', 'llm', 'LLM']) push(path.join(base, sub));
  }
  // 各盘的常见模型目录（限制深度，只认名字）
  for (const d of driveRoots()) {
    for (const name of ['models', 'Models', 'gguf', 'GGUF', 'AI-Models', 'Hermes\\models']) {
      push(path.join(d, name));
    }
  }
  return dirs;
}

/* -------------------------------------------------- 主扫描入口 */

/**
 * @param {object} opts { deep:boolean }
 *   deep=false（quick）：扫 Ollama 模型根 + 已知运行时缓存目录，深度 2，~2s
 *   deep=true（全盘）：额外扫各盘常见目录，深度 4，~8s
 */
function scan(opts = {}) {
  const deep = !!opts.deep;
  const t0 = Date.now();
  const deadline = t0 + (deep ? 12000 : 4000);
  const providers = [];
  const findings = [];

  /* 1) Ollama 磁盘模型（无论服务是否启动） */
  const ollamaRoots = ollamaModelRoots();
  let ollamaModels = [];
  for (const root of ollamaRoots) {
    ollamaModels = ollamaModels.concat(scanOllamaManifests(root));
  }
  // 去重
  const seenModel = new Set();
  ollamaModels = ollamaModels.filter((m) => {
    if (seenModel.has(m.id)) return false;
    seenModel.add(m.id);
    return true;
  });
  if (ollamaModels.length) {
    providers.push({
      id: 'disk:ollama',
      name: 'Ollama（本机模型文件）',
      vendor: 'Ollama',
      kind: 'local-file',
      endpoint: ollamaRoots[0] || '',
      status: 'installed',
      caps: ['local', 'models', 'disk'],
      source: 'disk-scan',
      detail: `磁盘发现 ${ollamaModels.length} 个模型 · ${ollamaRoots.slice(0, 2).join('、')}`,
      note: '模型已下载到本机。若 Ollama 服务未启动，先启动 Ollama 即可对话；启动后这些模型会出现在线 Ollama 通道里。',
      chatCapable: false,
      models: ollamaModels,
      modelCount: ollamaModels.length
    });
    findings.push(`Ollama 磁盘模型 ${ollamaModels.length} 个`);
  }

  /* 2) 通用模型文件（GGUF / safetensors 等） */
  const fileModels = [];
  const seenFile = new Set();
  const consider = (file) => {
    const base = path.basename(file);
    const highConf = MODEL_EXT.test(file);   // gguf/safetensors 等
    const ambiguous = AMBIG_EXT.test(file);   // bin/onnx/pt 等
    if (!highConf && !ambiguous) return;
    const name = nameFromModelFile(file);
    // 明确排除已知的软件数据文件
    if (NOT_MODEL.test(name)) return;
    if (seenFile.has(file)) return;
    seenFile.add(file);

    const st = stat(file);
    const bytes = st ? st.size : 0;
    // 模糊扩展名必须是大文件才可能是模型；GGUF 等保留小文件但标记为占位
    if (ambiguous && bytes < MIN_AMBIG_BYTES) return;
    const gb = Math.round((bytes / GB) * 10) / 10;
    const suspicious = bytes < 1024 * 1024; // <1MB 视为占位/不完整
    fileModels.push({
      id: `file:${base}:${bytes}:${path.dirname(file)}`,
      name,
      sizeGB: gb,
      speedTier: fileTier(gb),
      suspicious,
      ext: path.extname(file).slice(1).toLowerCase(),
      filePath: file,
      source: 'disk-scan'
    });
  };

  // 已知高概率目录（少量深度）
  const dirs = extraModelDirs();
  for (const dir of dirs) {
    if (Date.now() > deadline) break;
    walk(dir, { maxDepth: deep ? 4 : 2, deadline, maxDirs: deep ? 600 : 200, onFile: consider });
  }

  // 全盘模式：额外扫各盘的浅层（只到 2 层，避免翻遍系统盘）
  if (deep) {
    for (const d of driveRoots()) {
      if (Date.now() > deadline) break;
      walk(d, {
        maxDepth: 3,
        deadline,
        maxDirs: 1200,
        skip: SKIP_DIR,
        onFile: consider
      });
    }
  }

  // 去掉 Ollama blob 目录里的分片（那些不是可直接加载的模型文件）
  const cleaned = fileModels.filter((m) => {
    const p = m.filePath.replace(/\\/g, '/');
    return !/\/blobs\/sha256-/.test(p);
  });
  // 疑似占位/不完整文件（如 15 字节的 hermes-model.gguf）单独标记，不计入可用模型数
  const usable = cleaned.filter((m) => !m.suspicious);
  const placeholders = cleaned.filter((m) => m.suspicious);
  if (cleaned.length) {
    providers.push({
      id: 'disk:modelfiles',
      name: '本机模型文件（GGUF 等）',
      vendor: 'Local Files',
      kind: 'local-file',
      endpoint: usable[0] ? path.dirname(usable[0].filePath) : (cleaned[0] ? path.dirname(cleaned[0].filePath) : ''),
      status: 'installed',
      caps: ['local', 'models', 'disk', 'gguf'],
      source: 'disk-scan',
      detail: `磁盘发现 ${usable.length} 个可用模型文件${placeholders.length ? ` · ${placeholders.length} 个疑似占位/不完整` : ''}`,
      note: '这些是独立的模型文件，需用 llama.cpp / LM Studio 等运行时加载后才能对话。疑似占位文件（体积异常小）仅供参考，未计入可用模型。',
      chatCapable: false,
      models: usable.length ? usable : cleaned,
      modelCount: usable.length || cleaned.length,
      placeholders: placeholders.map((m) => ({ name: m.name, filePath: m.filePath, sizeGB: m.sizeGB }))
    });
    findings.push(`模型文件 ${usable.length} 个${placeholders.length ? `（${placeholders.length} 个占位）` : ''}`);
  }

  return {
    providers,
    roots: { ollama: ollamaRoots, extraDirs: dirs },
    findings,
    elapsedMs: Date.now() - t0,
    deep,
    scannedAt: new Date().toISOString()
  };
}

module.exports = { scan, ollamaModelRoots, walk, driveRoots };
