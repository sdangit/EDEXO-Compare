"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("edexoElectron", {
  openAppWindow: () => ipcRenderer.invoke("edexo:open-app-window"),
  pickFolder: (options) => ipcRenderer.invoke("edexo:pick-folder", options),
  saveTextFile: (options) => ipcRenderer.invoke("edexo:save-text-file", options),
  relaunch: () => ipcRenderer.invoke("edexo:relaunch"),
});
