#!/usr/bin/env node
'use strict';
/**
 * 根据 dist/ 里的安装包生成官网更新清单 version.json。
 * 用法：
 *   node build/make-version-json.js <dist-dir> <output-version.json> [notes-file]
 *
 * 只读取六个固定安装包并计算 SHA256 / 字节数，不执行任何安装文件。
 * 生成后把 version.json 放到官网根目录即可，软件「检查更新」会读取它。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [, , distArg, outArg, notesArg] = process.argv;
if (!distArg || !outArg) {
  console.error('用法: node build/make-version-json.js <dist-dir> <output-version.json> [notes-file]');
  process.exit(1);
}
const dist = path.resolve(distArg);
const out = path.resolve(outArg);
const pkg = require(path.join(__dirname, '..', 'package.json'));
const version = pkg.version;

const TARGETS = [
  ['windows-x64', `NEXUS-${version}-x64.exe`, 'nsis'],
  ['windows-x64-portable', `NEXUS-Portable-${version}.exe`, 'portable'],
  ['macos-x64', `NEXUS-${version}-x64.zip`, 'zip'],
  ['macos-arm64', `NEXUS-${version}-arm64.zip`, 'zip'],
  ['linux-x64', `NEXUS-${version}-x64.deb`, 'deb'],
  ['linux-x64-targz', `NEXUS-${version}-x64-linux.tar.gz`, 'targz']
];

const DEFAULT_NOTES = [
  '新增「检查更新」按钮：设置页与帮助菜单均可检查官网新版本并一键下载安装包',
  '全盘识别本机模型：可找出被环境变量重定向或未启动的 Ollama / GGUF 模型',
  'DeepSeek 式深度思考：可折叠思维链实时展示，思考完自动收起',
  '一键停止输出与思考：生成中按停止或 Esc，正文与思维链同时中断',
  'MCP 工具与 AI 模型分区展示，不再把工具算作模型'
];

let notes = DEFAULT_NOTES;
if (notesArg && fs.existsSync(notesArg)) {
  notes = fs.readFileSync(notesArg, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}

const packages = {};
for (const [key, file, kind] of TARGETS) {
  const full = path.join(dist, file);
  if (!fs.existsSync(full)) {
    console.error(`缺少安装包: ${full}`);
    process.exit(1);
  }
  const data = fs.readFileSync(full);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  packages[key] = { file, size: data.length, sha256, kind };
  console.log(`  ${key}: ${file} ${(data.length / 1048576).toFixed(1)}MB ${sha256.slice(0, 12)}…`);
}

const manifest = {
  schema: 1,
  latest: version,
  releasedAt: new Date().toISOString(),
  channel: 'stable',
  notes,
  packages
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`OK: ${out}`);
