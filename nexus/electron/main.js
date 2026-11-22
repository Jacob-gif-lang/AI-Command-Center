'use strict';
/**
 * Electron 主进程
 * 只做三件事：起本地服务 → 开窗口 → 处理系统级菜单/外链。
 * 业务逻辑一律不写在这里（保持在 server/ 与 renderer/ 中），便于无 Electron 降级运行。
 */
const { app, BrowserWindow, shell, Menu, nativeTheme, ipcMain } = require('electron');
const path = require('node:path');

const localServer = require('../server');
const updater = require('../server/update');

let mainWindow = null;
let serverInfo = null;
let quitting = false;

// Windows 上固定深色，避免首帧白闪
nativeTheme.themeSource = 'dark';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#08090d',
    title: 'NEXUS',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'win32'
      ? { color: '#0a0b10', symbolColor: '#9aa3b6', height: 40 }
      : undefined,
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外链交给系统浏览器，窗口内不允许跳走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (serverInfo && url.startsWith(serverInfo.url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  mainWindow.loadURL(serverInfo.url);
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '视图',
      submenu: [
        { label: '重新识别本机 AI', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.webContents.reload() },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新…',
          click: () => {
            if (!mainWindow) return;
            goSettingsAndCheck();
          }
        },
        { type: 'separator' },
        {
          label: '架构说明',
          click: () => shell.openPath(path.join(__dirname, '..', 'docs', 'ARCHITECTURE.md'))
        },
        {
          label: '打开数据目录',
          click: () => shell.openPath(require('node:path').join(process.env.APPDATA || app.getPath('userData'), 'Nexus'))
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 让渲染层跳到设置页并触发一次检查更新（菜单入口） */
function goSettingsAndCheck() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.executeJavaScript(
    "window.NexusApp && (window.NexusApp.go('settings'), window.NexusApp.checkUpdate && window.NexusApp.checkUpdate(true))"
  ).catch(() => {});
}

/** 安全打开下载好的安装包：只接受 NEXUS 更新目录内的白名单文件，交给系统处理 */
function registerUpdateIpc() {
  ipcMain.handle('nexus:open-installer', async (_event, filePath) => {
    const safe = updater.safeLocalPath(filePath);
    if (!safe) return { ok: false, message: '安装包路径不合法或文件不存在' };
    const err = await shell.openPath(safe);
    if (err) return { ok: false, message: err };
    return { ok: true };
  });
  ipcMain.handle('nexus:open-downloads', async () => {
    const err = await shell.openPath(updater.updatesDir());
    return err ? { ok: false, message: err } : { ok: true };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      serverInfo = await localServer.start({ port: Number(process.env.NEXUS_PORT) || 8788, quiet: true });
    } catch (err) {
      // 服务起不来时兜底打开一个说明页，避免出现纯白窗口
      serverInfo = { url: 'data:text/html,' + encodeURIComponent('<h1 style="font-family:Segoe UI;padding:40px">NEXUS 本地服务启动失败</h1><p>' + String(err) + '</p>') };
    }
    buildMenu();
    registerUpdateIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => { quitting = true; });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    if (serverInfo && serverInfo.server) {
      try { serverInfo.server.close(); } catch { /* ignore */ }
    }
    void quitting;
  });
}
