#!/usr/bin/env node
'use strict';
// 纯 Node 生成 Linux 安装包，不依赖系统 tar / ar / dpkg。
//  - 默认：标准 .deb（debian-binary + control.tar.gz + data.tar.gz）
//  - --targz：免安装 .tar.gz
// 重要：Windows 构建环境不保留 Unix 可执行位，必须在此显式写入，
//       否则用户安装/解压后主程序是 0644，无法运行。
// 用法:
//   node make-deb.js <linux-unpacked-dir> <out.deb>
//   node make-deb.js <linux-unpacked-dir> <out.tar.gz> --targz

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [, , srcArg, outArg, modeArg] = process.argv;
if (!srcArg || !outArg) {
  console.error('用法: node make-deb.js <linux-unpacked-dir> <out.deb> [--targz]');
  process.exit(1);
}
const src = path.resolve(srcArg);
const out = path.resolve(outArg);
const asTargz = modeArg === '--targz';
const pkg = require(path.join(__dirname, '..', '..', 'package.json'));

// Electron Linux 需要的可执行位。chrome-sandbox 按上游惯例 setuid root，
// 这样 Chromium 沙箱能正常工作（比加 --no-sandbox 更安全）。
const EXEC_MODE = {
  'nexus-ai-orchestrator': 0o755,
  'chrome-sandbox': 0o4755
};

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function tarHeader(name, size, typeflag, mode) {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 100, 'utf8');
  h.write(octal(mode || 0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii');
  h.fill(0x20, 148, 156);
  h.write(typeflag, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(octal(sum, 8).slice(0, 6) + '\0 ', 148, 8, 'ascii');
  return h;
}

function tarFiles(files) {
  const parts = [];
  for (const f of files) {
    const name = f.name.replace(/^\.\//, '').replace(/\\/g, '/');
    const isDir = f.type === 'dir';
    const size = isDir ? 0 : f.data.length;
    parts.push(tarHeader(name + (isDir ? '/' : ''), size, isDir ? '5' : '0', isDir ? 0o755 : f.mode || 0o644));
    if (!isDir && size) {
      parts.push(f.data);
      const pad = (512 - (size % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function walk(dir, prefix, files) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      files.push({ name: rel, type: 'dir' });
      walk(full, rel, files);
    } else if (stat.isFile()) {
      files.push({
        name: rel,
        type: 'file',
        mode: EXEC_MODE[name] || 0o644,
        data: fs.readFileSync(full)
      });
    }
  }
}

function writeOut(buf) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log(`OK: ${out} (${(buf.length / 1048576).toFixed(1)} MB)`);
}

/* ---------------- 免安装 tar.gz：解开即用，主程序带执行位 ---------------- */
if (asTargz) {
  const files = [];
  walk(src, '', files);
  writeOut(zlib.gzipSync(tarFiles(files)));
  process.exit(0);
}

/* ---------------- 标准 deb ---------------- */
// data.tar.gz：/usr/share/nexus 放程序，/usr/bin/nexus 为启动命令，并提供桌面入口。
const dataFiles = [
  { name: 'usr', type: 'dir' },
  { name: 'usr/share', type: 'dir' },
  { name: 'usr/share/nexus', type: 'dir' }
];
walk(src, 'usr/share/nexus', dataFiles);
dataFiles.push(
  { name: 'usr/bin', type: 'dir' },
  { name: 'usr/share/applications', type: 'dir' },
  { name: 'usr/bin/nexus', type: 'file', mode: 0o755,
    data: Buffer.from('#!/bin/sh\nexec /usr/share/nexus/nexus-ai-orchestrator "$@"\n') },
  { name: 'usr/share/applications/nexus.desktop', type: 'file', mode: 0o644,
    data: Buffer.from('[Desktop Entry]\nName=NEXUS\nComment=Local AI Orchestrator\nExec=nexus\nType=Application\nCategories=Utility;\n') }
);
const dataTgz = zlib.gzipSync(tarFiles(dataFiles));

// 没有任何 maintainer scripts：安装/卸载只增删上面列出的文件，不执行系统命令。
const controlText =
  `Package: nexus\nVersion: ${pkg.version}\nSection: utils\nPriority: optional\n` +
  `Architecture: amd64\nMaintainer: Jacob <jacob@local.dev>\n` +
  `Description: NEXUS local AI orchestrator\n NEXUS - local AI orchestration hub for Windows/macOS/Linux.\n`;
const controlTgz = zlib.gzipSync(tarFiles([
  { name: 'control', type: 'file', mode: 0o644, data: Buffer.from(controlText) }
]));

function arHeader(name, size) {
  const h = Buffer.alloc(60, 0x20);
  h.write(name.padEnd(16), 0, 16, 'ascii');
  h.write('0'.padEnd(12), 16, 12, 'ascii');
  h.write('0'.padEnd(6), 28, 6, 'ascii');
  h.write('0'.padEnd(6), 34, 6, 'ascii');
  h.write('100644'.padEnd(8), 40, 8, 'ascii');
  h.write(String(size).padEnd(10), 48, 10, 'ascii');
  h.write('`\n', 58, 2, 'ascii');
  return h;
}
function addMember(parts, name, buf) {
  parts.push(arHeader(name, buf.length), buf);
  if (buf.length % 2 === 1) parts.push(Buffer.from('\n'));
}
const parts = [Buffer.from('!<arch>\n')];
addMember(parts, 'debian-binary', Buffer.from('2.0\n'));
addMember(parts, 'control.tar.gz', controlTgz);
addMember(parts, 'data.tar.gz', dataTgz);
writeOut(Buffer.concat(parts));
