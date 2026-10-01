"use strict";

// macOS shell: the same browser/server app, with no HUD windows, tray or game-process hooks.
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { existsSync, writeFileSync } = require("node:fs");
const path = require("node:path");
let runtime;
let launcher;
let appWindow;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (launcher) {
      if (launcher.isMinimized()) launcher.restore();
      launcher.show();
      launcher.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      const resources = process.resourcesPath;
      const packagedBundle = path.join(resources, "edexo", "app.cjs");
      const packaged = existsSync(packagedBundle);
      if (packaged) {
        process.env.EDEXO_ELECTRON_PACKAGED = "1";
        process.env.EDEXO_RESOURCES_ROOT = resources;
      }
      process.env.EDEXO_ELECTRON = "1";
      process.env.EDEXO_SKIP_DEVENTRY_AUTOSTART = "1";
      process.env.EDEXO_LEGACY_USER_DATA_DIR = app.getPath("userData");
      const { startEdexoFromElectronMode } = require(
        packaged ? packagedBundle : path.join(__dirname, "../build/app.cjs"),
      );
      runtime = await startEdexoFromElectronMode("client");
      const base = runtime.getLocalBaseUrl();
      function createWindow(options) {
        const win = new BrowserWindow({
          ...options,
          backgroundColor: "#050507",
          webPreferences: {
            preload: path.join(__dirname, "preload.mac.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
          },
        });
        win.webContents.setWindowOpenHandler(({ url }) => {
          if (url.startsWith(`${base}/`)) {
            const child = createWindow({ width: 1200, height: 850 });
            void child.loadURL(url);
          } else if (/^https?:\/\//.test(url)) void shell.openExternal(url);
          return { action: "deny" };
        });
        win.webContents.on("will-navigate", (event, url) => {
          if (!url.startsWith(`${base}/`)) {
            event.preventDefault();
            if (/^https?:\/\//.test(url)) void shell.openExternal(url);
          }
        });
        return win;
      }
      launcher = createWindow({ width: 600, height: 900, minWidth: 480, minHeight: 600 });
      const fromLauncher = (event) => launcher && event.sender === launcher.webContents;
      ipcMain.handle("edexo:open-app-window", () => {
        if (appWindow && !appWindow.isDestroyed()) {
          appWindow.show();
          appWindow.focus();
        } else {
          appWindow = createWindow({ width: 1400, height: 950 });
          void appWindow.loadURL(`${base}/`);
        }
        return { opened: true };
      });
      ipcMain.handle("edexo:pick-folder", async (event, options) => {
        if (!fromLauncher(event)) return { path: null };
        const result = await dialog.showOpenDialog(launcher, {
          properties: ["openDirectory", "createDirectory"],
          defaultPath: typeof options?.defaultPath === "string" ? options.defaultPath : undefined,
        });
        return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
      });
      ipcMain.handle("edexo:save-text-file", async (event, options) => {
        if (!fromLauncher(event) || typeof options?.text !== "string") return { saved: false };
        const result = await dialog.showSaveDialog(launcher, {
          defaultPath: path.join(
            app.getPath("downloads"),
            path.basename(options.defaultName || "EDEXO.json"),
          ),
        });
        if (result.canceled || !result.filePath) return { saved: false };
        writeFileSync(result.filePath, options.text, "utf8");
        return { saved: true, path: result.filePath };
      });
      ipcMain.handle("edexo:relaunch", (event) => {
        if (!fromLauncher(event)) return { ok: false };
        app.relaunch();
        app.quit();
        return { ok: true };
      });
      await launcher.loadURL(`${base}/launcher.html`);
    })
    .catch((error) => {
      dialog.showErrorBox("ED Exo Compare — startup failed", String(error?.stack || error));
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting || !runtime) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      if (runtime.backupRunning()) await runtime.whenBackupDone();
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
      await runtime.shutdown();
    })().finally(() => app.quit());
  });
}
