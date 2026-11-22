'use strict';
/**
 * 音频控制桥接层
 * ------------------------------------------------------------
 * Windows 上精确控制「正在发声的程序」需要 Core Audio API，
 * Node 无原生绑定，这里通过 child_process 调用随包附带的 audio_ctl.py（pycaw）。
 * 设计要点：
 *   - 打包后 audio_ctl.py 位于 asar 内，Python 无法直接读取；启动时把它释放到
 *     %APPDATA%\Nexus\audio_ctl.py 再执行（源码模式直接用仓库内脚本）。
 *   - Python 探测必须验证 pycaw 真的可用（返回 ok:true），不把「能启动」误判为可用。
 *   - 所有调用都设超时，绝不阻塞主服务；缺依赖时优雅降级，不影响其它功能。
 */
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Nexus');
const SRC_SCRIPT = path.join(__dirname, 'audio_ctl.py');
const RUNTIME_SCRIPT = path.join(ROOT, 'audio_ctl.py');
const CACHE = path.join(ROOT, 'python-path.json');
// 依赖只装到 NEXUS 自己的数据目录，绝不写入用户全局 Python 环境。
const PY_DEPS = path.join(ROOT, 'pydeps');
const AUDIO_STATE = path.join(ROOT, 'audio-state.json');

let cachedPython = null;
let scriptPath = null;

/* 取得一个 Python 可读的脚本路径（asar 内则释放到磁盘） */
function ensureScript() {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  try {
    if (!SRC_SCRIPT.includes('app.asar') && fs.existsSync(SRC_SCRIPT)) {
      scriptPath = SRC_SCRIPT;
      return scriptPath;
    }
  } catch { /* ignore */ }
  // 打包环境：从 asar 内读出脚本内容写到 %APPDATA%\Nexus
  try {
    const content = fs.readFileSync(SRC_SCRIPT, 'utf8');
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(RUNTIME_SCRIPT, content, 'utf8');
    scriptPath = RUNTIME_SCRIPT;
  } catch (e) {
    scriptPath = null;
  }
  return scriptPath;
}

function candidatePythons() {
  const list = [];
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8')).python;
    if (cached) list.push(cached);
  } catch { /* ignore */ }
  if (process.env.NEXUS_PYTHON) list.push(process.env.NEXUS_PYTHON);
  list.push(
    'C:\\Python314\\python.exe',
    'C:\\Python313\\python.exe',
    'C:\\Python312\\python.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
    'python', 'py'
  );
  return list;
}

function runPy(python, args, timeout) {
  return new Promise((resolve) => {
    const script = ensureScript();
    if (!script) return resolve({ ok: false, error: 'script_unavailable' });
    const opts = { timeout: timeout || 12000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
    if (fs.existsSync(PY_DEPS)) {
      opts.env = Object.assign({}, process.env, {
        PYTHONPATH: PY_DEPS + path.delimiter + (process.env.PYTHONPATH || '')
      });
    }
    let finalArgs;
    if (python === 'py') finalArgs = ['-3', script, ...args];
    else finalArgs = [script, ...args];
    execFile(python, finalArgs, opts, (err, stdout) => {
      if (err && !stdout) return resolve({ ok: false, error: 'exec_failed', detail: String(err.message || err) });
      try {
        const j = JSON.parse(String(stdout).trim());
        resolve(j);
      } catch {
        resolve({ ok: false, error: 'bad_output', detail: String(stdout || '').slice(0, 200) });
      }
    });
  });
}

/* 探测时强制用 status 命令：只有返回 ok:true 才算 pycaw 可用 */
async function probe(python) {
  const r = await runPy(python, ['status'], 12000);
  return (r && r.ok === true) ? r : null;
}

function cachePython(p) {
  cachedPython = p;
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify({ python: p }), 'utf8');
  } catch { /* ignore */ }
}

async function findPython() {
  if (cachedPython) return cachedPython;
  for (const p of candidatePythons()) {
    if (!p) continue;
    const ok = await probe(p);
    if (ok) { cachePython(p); return p; }
  }
  return null;
}

async function ensurePycaw(python) {
  return new Promise((resolve) => {
    try { fs.mkdirSync(PY_DEPS, { recursive: true }); } catch { return resolve(false); }
    // --target 隔离安装：不修改用户全局 site-packages，不要求管理员权限。
    execFile(python, ['-m', 'pip', 'install', '--target', PY_DEPS,
      '--disable-pip-version-check', '-q', 'pycaw'],
    { timeout: 90000, windowsHide: true }, (e) => resolve(!e));
  });
}

async function call(cmd) {
  if (!ensureScript()) {
    return { ok: false, error: 'script_unavailable', message: '音频控制脚本不可用' };
  }
  let python = await findPython();
  if (!python) {
    // 首次运行自愈：找一个能启动的 Python，装 pycaw 后重试一次
    for (const p of candidatePythons()) {
      if (!p) continue;
      const canRun = await runPy(p, ['status'], 10000);
      if (canRun && canRun.error === 'pycaw_unavailable') {
        if (await ensurePycaw(p)) {
          const ok = await probe(p);
          if (ok) { cachePython(p); python = p; break; }
        }
      }
    }
    if (!python) {
      return { ok: false, error: 'python_not_found',
        message: '未找到可用的 Python 3 + pycaw（需可联网首次安装）。可用 NEXUS_PYTHON 环境变量指定解释器。' };
    }
  }
  return runPy(python, [cmd], 15000);
}

function savedSids() {
  try {
    const s = JSON.parse(fs.readFileSync(AUDIO_STATE, 'utf8')).sids;
    return Array.isArray(s) ? s : [];
  } catch { return []; }
}

function cachedPythonPath() {
  if (cachedPython) return cachedPython;
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')).python || null; } catch { return null; }
}

/**
 * 声音开关只应在 NEXUS 运行期间生效。
 * 若上次异常退出遗留静音会话，启动时按 SID 精确恢复，不触碰用户其它音频设置。
 * 只用已缓存的解释器，不触发 pip 安装，不阻塞启动。
 */
function restorePending() {
  if (!savedSids().length) return Promise.resolve({ skipped: true });
  const python = cachedPythonPath();
  if (!python) return Promise.resolve({ skipped: true, reason: 'no_cached_python' });
  return runPy(python, ['unmute'], 15000);
}

/** 正常退出时同步恢复，确保关闭软件后用户的声音立即回到原状。 */
function restoreOnExit() {
  if (!savedSids().length) return;
  const python = cachedPythonPath();
  const script = scriptPath;
  if (!python || !script) return;
  const args = python === 'py' ? ['-3', script, 'unmute'] : [script, 'unmute'];
  try {
    execFileSync(python, args, {
      timeout: 3000, windowsHide: true, stdio: 'ignore',
      env: fs.existsSync(PY_DEPS)
        ? Object.assign({}, process.env, { PYTHONPATH: PY_DEPS + path.delimiter + (process.env.PYTHONPATH || '') })
        : process.env
    });
  } catch { /* 退出路径不抛错 */ }
}
process.on('exit', restoreOnExit);

module.exports = {
  status: () => call('status'),
  list: () => call('list'),
  mute: () => call('mute'),
  unmute: () => call('unmute'),
  toggle: () => call('toggle'),
  restorePending
};
