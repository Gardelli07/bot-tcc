// preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onQR: (cb) => ipcRenderer.on("qr", (event, dataUrl) => cb(dataUrl)),
  onLog: (cb) => ipcRenderer.on("log", (event, msg) => cb(msg)),
  startBot: () => ipcRenderer.send("start-bot"),
  stopBot: () => ipcRenderer.send("stop-bot"),
});
