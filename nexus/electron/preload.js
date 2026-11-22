'use strict';
/**
 * 预加载脚本：只暴露只读的宿主信息，不暴露 Node 能力。
 * 渲染层与后端的所有通信统一走 HTTP（见 server/index.js 注释）。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexusHost', {
  electron: true,
  platform: process.platform,
  arch: process.arch,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  // 更新：只把「打开安装包」这个系统级动作交给主进程，并做路径白名单校验。
  openInstaller: (filePath) => ipcRenderer.invoke('nexus:open-installer', filePath),
  openDownloads: () => ipcRenderer.invoke('nexus:open-downloads')
});
