'use strict';
/**
 * 软件自更新模块（Local Service Layer）
 * ------------------------------------------------------------
 * 只做三件事：
 *   1. check   —— 从官网读取 version.json，与当前版本比较，挑出本平台安装包；
 *   2. download—— 把安装包流式下载到 %APPDATA%\Nexus\updates\，边下边算 SHA256；
 *   3. jobs    —— 暴露下载进度供前端轮询，支持取消。
 *
 * 安全边界：
 *   - 更新源默认指向本项目官网 HTTPS 地址，可在设置里改（仅允许 https / 本机回环）；
 *   - 下载文件名严格白名单（只允许 6 个固定安装包名），杜绝路径穿越；
 *   - 下载完成后校验 SHA256 与文件大小，任一不符即丢弃；
 *   - 文件只写进 NEXUS 自己的数据目录，不碰系统目录、不自动执行安装；
 *     真正的「打开安装包」由 Electron 主进程在校验路径后交给系统完成。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_FEED = 'https://nexus-official.app.workbuddy.host/version.json?sharecode=HDR676KA2G';
const CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PACKAGE_BYTES = 400 * 1024 * 1024; // 400MB 上限，异常清单直接拒绝

/** 只在白名单里的文件名才允许下载，避免任何路径穿越/任意文件写入 */
const ALLOWED_FILE = /^(NEXUS-\d+\.\d+\.\d+-(x64|arm64|x64-linux)(-(x64|arm64))?|NEXUS-Portable-\d+\.\d+\.\d+)\.(exe|zip|deb|tar\.gz)$/;

/** 下载任务：id -> { state, received, total, percent, path, error, controller } */
const jobs = new Map();
let feedCache = { at: 0, data: null, url: '' };
let inflightCheck = null;

function updatesDir() {
  const root = process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming');
  const dir = path.join(root, 'Nexus', 'updates');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

function versionParts(v) {
  return String(v || '').replace(/^v/, '').split(/[.\-+]/).slice(0, 3).map((n) => {
    const p = parseInt(n, 10);
    return Number.isFinite(p) ? p : 0;
  });
}

function compareVersions(a, b) {
  const A = versionParts(a);
  const B = versionParts(b);
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] > B[i] ? 1 : -1;
  }
  return 0;
}

/** 解析更新源，强制 HTTPS（或本机回环），返回 { url, origin, share } */
function feedLocation(customUrl) {
  let raw = String(customUrl || process.env.NEXUS_UPDATE_URL || DEFAULT_FEED).trim();
  if (!raw) raw = DEFAULT_FEED;
  let u;
  try { u = new URL(raw); } catch { throw new Error('更新源地址无效'); }
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname);
  if (u.protocol !== 'https:' && !loopback) throw new Error('更新源必须使用 HTTPS');
  return { url: u.toString(), origin: u.origin, share: u.searchParams.get('sharecode') ? `?sharecode=${encodeURIComponent(u.searchParams.get('sharecode'))}` : '' };
}

/** 根据平台/架构从清单里挑最合适的包 */
function pickPackage(manifest, platform, arch) {
  const p = (manifest && manifest.packages) || {};
  if (platform === 'win32') {
    return p['windows-x64'] || p['windows-x64-portable'] || null;
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? (p['macos-arm64'] || null) : (p['macos-x64'] || null);
  }
  if (platform === 'linux') {
    return p['linux-x64'] || p['linux-x64-targz'] || null;
  }
  return null;
}

function normalizeManifest(data) {
  if (!data || typeof data !== 'object' || !data.latest || !data.packages) {
    throw new Error('更新清单格式不正确');
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(data.latest))) {
    throw new Error('更新清单版本号格式不正确');
  }
  const packages = {};
  for (const [key, value] of Object.entries(data.packages)) {
    if (!value || typeof value.file !== 'string' || !ALLOWED_FILE.test(value.file)) continue;
    const size = Number(value.size) || 0;
    if (size > MAX_PACKAGE_BYTES) continue;
    packages[key] = {
      file: value.file,
      size,
      sha256: String(value.sha256 || '').toLowerCase(),
      kind: String(value.kind || 'installer')
    };
  }
  if (!Object.keys(packages).length) throw new Error('更新清单中没有可用安装包');
  return {
    latest: String(data.latest),
    releasedAt: data.releasedAt || null,
    channel: data.channel || 'stable',
    notes: Array.isArray(data.notes) ? data.notes.slice(0, 12).map((n) => String(n)) : [],
    packages
  };
}

/**
 * 检查更新。currentVersion 由调用方从 APP_VERSION 传入。
 * force=true 时跳过缓存（用户主动点「检查更新」）。
 */
async function check(currentVersion, { force = false, platform, arch, feedUrl } = {}) {
  if (!force && inflightCheck) return inflightCheck;
  const loc = feedLocation(feedUrl);
  const fresh = feedCache.data && Date.now() - feedCache.at < CACHE_MS && feedCache.url === loc.url;
  if (!force && fresh) return buildResult(feedCache.data, currentVersion, platform, arch, loc);

  inflightCheck = (async () => {
    const res = await fetch(loc.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) throw new Error(`读取更新清单失败（HTTP ${res.status}）`);
    const raw = await res.json();
    const data = normalizeManifest(raw);
    feedCache = { at: Date.now(), data, url: loc.url };
    return buildResult(data, currentVersion, platform, arch, loc);
  })();

  try { return await inflightCheck; }
  finally { inflightCheck = null; }
}

function buildResult(data, currentVersion, platform, arch, loc) {
  const pkg = pickPackage(data, platform || process.platform, arch || process.arch);
  return {
    current: String(currentVersion || ''),
    latest: data.latest,
    available: compareVersions(data.latest, currentVersion) > 0,
    releasedAt: data.releasedAt,
    channel: data.channel,
    notes: data.notes,
    platform: platform || process.platform,
    arch: arch || process.arch,
    package: pkg,
    feed: loc.url,
    downloadUrl: pkg ? `${loc.origin}/downloads/${encodeURIComponent(pkg.file)}${loc.share}` : null
  };
}

function assetUrl(pkg, loc) {
  return `${loc.origin}/downloads/${encodeURIComponent(pkg.file)}${loc.share}`;
}

/**
 * 启动下载，立即返回 { jobId }。实际传输在后台进行，用 jobs() 轮询进度。
 */
function startDownload(pkg, { feedUrl } = {}) {
  if (!pkg || !ALLOWED_FILE.test(pkg.file)) throw new Error('安装包名不在允许范围内');
  const loc = feedLocation(feedUrl);
  const dir = updatesDir();
  const target = path.join(dir, pkg.file);
  const part = target + '.part';

  // 相同文件已在下载中 → 复用同一个任务
  for (const [id, job] of jobs.entries()) {
    if (job.file === pkg.file && (job.state === 'downloading' || job.state === 'done')) {
      return { jobId: id, reused: true };
    }
  }

  // 已存在且校验通过 → 直接完成
  try {
    if (fs.existsSync(target) && (!pkg.sha256 || sha256File(target) === pkg.sha256)) {
      const id = 'upd-' + Date.now().toString(36);
      jobs.set(id, { state: 'done', received: pkg.size || fs.statSync(target).size, total: pkg.size || fs.statSync(target).size, percent: 100, path: target, file: pkg.file, error: null });
      return { jobId: id, reused: true };
    }
  } catch { /* ignore，重新下载 */ }

  const id = 'upd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const controller = new AbortController();
  const job = {
    state: 'downloading', received: 0, total: Number(pkg.size) || 0, percent: 0,
    path: null, file: pkg.file, error: null, controller, startedAt: Date.now()
  };
  jobs.set(id, job);

  (async () => {
    let handle = null;
    try {
      try { fs.unlinkSync(part); } catch { /* ignore */ }
      handle = fs.openSync(part, 'w');
      const url = assetUrl(pkg, loc);
      // 同时用整体超时和手动取消
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, { signal: controller.signal, headers: { 'Cache-Control': 'no-cache' } });
      } finally { clearTimeout(timer); }
      if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
      const declared = Number(res.headers.get('content-length')) || job.total;
      if (declared > MAX_PACKAGE_BYTES) throw new Error('安装包体积异常，已拒绝下载');
      if (declared && !job.total) job.total = declared;

      const hash = crypto.createHash('sha256');
      let received = 0;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (controller.signal.aborted) throw new Error('已取消下载');
          const buf = Buffer.from(value);
          received += buf.length;
          if (received > MAX_PACKAGE_BYTES) throw new Error('安装包体积异常，已中止下载');
          fs.writeSync(handle, buf);
          hash.update(buf);
          job.received = received;
          job.percent = job.total ? Math.min(99, Math.round((received / job.total) * 100)) : 0;
        }
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        received = buf.length;
        if (received > MAX_PACKAGE_BYTES) throw new Error('安装包体积异常，已拒绝下载');
        fs.writeSync(handle, buf);
        hash.update(buf);
        job.received = received;
        job.percent = 99;
      }
      fs.closeSync(handle); handle = null;

      const digest = hash.digest('hex');
      if (pkg.sha256 && digest !== pkg.sha256) throw new Error('安装包校验失败（SHA256 不匹配），已丢弃');
      if (job.total && received !== job.total) throw new Error('安装包大小不符，已丢弃');
      fs.renameSync(part, target);
      job.state = 'done';
      job.percent = 100;
      job.path = target;
      job.received = received;
      job.total = received;
      pruneOld(dir, pkg.file);
    } catch (err) {
      if (handle !== null) { try { fs.closeSync(handle); } catch { /* ignore */ } }
      try { fs.unlinkSync(part); } catch { /* ignore */ }
      job.state = controller.signal.aborted ? 'cancelled' : 'error';
      job.error = controller.signal.aborted ? '已取消下载' : (err.message || '下载失败');
    }
  })();

  return { jobId: id, reused: false };
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const data = fs.readFileSync(file);
  h.update(data);
  return h.digest('hex');
}

/** 只保留最近 3 个安装包，避免更新目录无限膨胀 */
function pruneOld(dir, keepName) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => ALLOWED_FILE.test(f) && f !== keepName)
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const item of files.slice(2)) {
      try { fs.unlinkSync(path.join(dir, item.f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function getJob(id) {
  const j = jobs.get(id);
  if (!j) return { state: 'not_found', error: '下载任务不存在或已过期' };
  const { state, received, total, percent, path: filePath, error, file } = j;
  return { state, received, total, percent, path: filePath, error, file };
}

function cancel(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.state === 'downloading' && j.controller) {
    try { j.controller.abort(); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/** 校验由前端传入的本地路径确实位于 NEXUS 更新目录且是白名单文件名 */
function safeLocalPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const dir = path.resolve(updatesDir());
  const target = path.resolve(filePath);
  if (!target.startsWith(dir + path.sep)) return null;
  if (!ALLOWED_FILE.test(path.basename(target))) return null;
  if (!fs.existsSync(target)) return null;
  return target;
}

module.exports = {
  check,
  startDownload,
  getJob,
  cancel,
  safeLocalPath,
  updatesDir,
  compareVersions,
  DEFAULT_FEED
};
