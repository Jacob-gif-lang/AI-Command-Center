#!/usr/bin/env node
'use strict';
// 在 Windows 上把 Electron 官方 darwin 二进制 + 本项目源码组装成标准 macOS .app，并压缩为 zip。
// 用法: node build/mac/make-mac-app.js <arch: x64|arm64>

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const arch = process.argv[2] === 'arm64' ? 'arm64' : 'x64';
const zipPath = path.join(__dirname, `electron-darwin-${arch}.zip`);
const work = path.join(__dirname, `stage-${arch}`);
const appName = 'NEXUS.app';
const version = require(path.join(root, 'package.json')).version;
const outZip = path.join(root, 'dist', `NEXUS-${version}-${arch}.zip`);

if (!fs.existsSync(zipPath)) {
  console.error(`缺少二进制: ${zipPath}`);
  process.exit(1);
}

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// 1) 解压 Electron.app
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${work}" -Force`], { stdio: 'inherit' });

let electronApp = path.join(work, 'Electron.app');
if (!fs.existsSync(electronApp)) {
  const found = fs.readdirSync(work).find((n) => n.endsWith('.app'));
  if (!found) { console.error('解压后未找到 Electron.app'); process.exit(1); }
  electronApp = path.join(work, found);
}
const nexusApp = path.join(work, appName);
if (electronApp !== nexusApp) fs.renameSync(electronApp, nexusApp);

const contents = path.join(nexusApp, 'Contents');
const resources = path.join(contents, 'Resources');
const appDir = path.join(resources, 'app');

// 2) 放入应用源码（排除 node_modules / dist / .git）
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });
for (const item of ['electron', 'server', 'renderer', 'docs', 'package.json', 'README.md', 'bin']) {
  const src = path.join(root, item);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(appDir, item), { recursive: true });
}

// 3) 修改 Info.plist 的应用名与标识
const plistPath = path.join(contents, 'Info.plist');
if (fs.existsSync(plistPath)) {
  let plist = fs.readFileSync(plistPath, 'utf8');
  plist = plist.replace(/<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/,
    '<key>CFBundleName</key>\n    <string>NEXUS</string>');
  plist = plist.replace(/<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/,
    '<key>CFBundleDisplayName</key>\n    <string>NEXUS</string>');
  plist = plist.replace(/<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/,
    '<key>CFBundleIdentifier</key>\n    <string>com.jacob.nexus</string>');
  plist = plist.replace(/<key>CFBundleExecutable<\/key>\s*<string>[^<]*<\/string>/,
    '<key>CFBundleExecutable</key>\n    <string>NEXUS</string>');
  fs.writeFileSync(plistPath, plist);
}

// 4) MacOS 可执行文件名与 Info.plist 保持一致
const macosDir = path.join(contents, 'MacOS');
if (fs.existsSync(macosDir)) {
  const exe = fs.readdirSync(macosDir)[0];
  if (exe && exe !== 'NEXUS') fs.renameSync(path.join(macosDir, exe), path.join(macosDir, 'NEXUS'));
}

// 5) 用 PowerShell Compress-Archive 生成 zip
fs.mkdirSync(path.dirname(outZip), { recursive: true });
if (fs.existsSync(outZip)) fs.rmSync(outZip, { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Compress-Archive -LiteralPath "${nexusApp}" -DestinationPath "${outZip}" -CompressionLevel Optimal`], { stdio: 'inherit' });

console.log(`OK: ${outZip} (${(fs.statSync(outZip).size / 1048576).toFixed(1)} MB)`);
