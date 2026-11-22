#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const pkg = require('../package.json');

const args = process.argv.slice(2);
const command = args[0] || 'start';
const root = path.join(__dirname, '..');

function help() {
  console.log(`
NEXUS v${pkg.version} · 本机 AI 编排中枢

用法:
  nexus              启动 Web 服务（默认，等同于 nexus start）
  nexus web          启动 Web 服务  http://127.0.0.1:8788
  nexus desktop      启动 Electron 桌面窗口（需本机安装 electron）
  nexus check        运行自检
  nexus --version    显示版本
  nexus help         显示本帮助

补充说明:
  Web 模式只需要 Node.js >= 20，无需额外依赖。
  桌面模式需要安装 electron（npm i electron）。
`);
}

if (command === '--version' || command === '-v') {
  console.log(pkg.version);
  process.exit(0);
}

if (command === 'help' || command === '--help' || command === '-h') {
  help();
  process.exit(0);
}

if (command === 'check') {
  const child = spawn(process.execPath, [path.join(root, 'server', 'selftest.js')], {
    stdio: 'inherit',
    cwd: root,
  });
  child.on('exit', (code) => process.exit(code || 0));
} else if (command === 'web' || command === 'start') {
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js'), ...args.slice(1)], {
    stdio: 'inherit',
    cwd: root,
  });
  child.on('exit', (code) => process.exit(code || 0));
} else if (command === 'desktop') {
  let electron;
  try {
    electron = require('electron');
  } catch (e) {
    console.error('未找到 electron，请先运行: npm i electron');
    process.exit(1);
  }
  const child = spawn(electron, [root, ...args.slice(1)], { stdio: 'inherit', cwd: root });
  child.on('exit', (code) => process.exit(code || 0));
} else {
  console.error(`未知命令: ${command}`);
  help();
  process.exit(1);
}
