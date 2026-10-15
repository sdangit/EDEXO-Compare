import { readFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Sender = { sender: EventEmitter };
type Handler = (event: Sender, options?: Record<string, unknown>) => unknown;

// Execute the real shell with fake Electron surfaces: exercise lifecycle and IPC without a GUI.
async function boot({ packaged = true, lock = true } = {}) {
  const handlers = new Map<string, Handler>();
  const windows: FakeWindow[] = [];
  class FakeWindow {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    loadURL = vi.fn(async () => {});
    show = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    isMinimized = vi.fn(() => false);
    isDestroyed = vi.fn(() => false);
    destroy = vi.fn();
    constructor(public options: Record<string, unknown>) {
      windows.push(this);
    }
    static getAllWindows() {
      return windows;
    }
  }
  const runtime = {
    getLocalBaseUrl: () => "http://127.0.0.1:7111",
    backupRunning: vi.fn(() => false),
    whenBackupDone: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: vi.fn(() => lock),
    quit: vi.fn(),
    relaunch: vi.fn(),
    getPath: vi.fn((name: string) => `/fake/${name}`),
    whenReady: vi.fn(async () => {}),
  });
  const dialog = {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/chosen journal"] })),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: "/chosen export" })),
    showErrorBox: vi.fn(),
  };
  const shell = { openExternal: vi.fn() };
  const writeFileSync = vi.fn();
  const start = vi.fn(async () => runtime);
  const fakeProcess = { resourcesPath: "/fake/resources", env: {} as Record<string, string> };
  const requireModule = vi.fn((name: string) => {
    if (name === "electron")
      return {
        app,
        BrowserWindow: FakeWindow,
        dialog,
        shell,
        ipcMain: { handle: (key: string, handler: Handler) => handlers.set(key, handler) },
      };
    if (name === "node:fs") return { existsSync: () => packaged, writeFileSync };
    if (name === "node:path") return path;
    if (name.endsWith("app.cjs")) return { startEdexoFromElectronMode: start };
    throw new Error(`Unexpected dependency: ${name}`);
  });
  runInNewContext(readFileSync("electron/main.mac.cjs", "utf8"), {
    require: requireModule,
    process: fakeProcess,
    __dirname: path.resolve("electron"),
  });
  await vi.waitFor(() => expect(lock ? windows[0]?.loadURL : app.quit).toHaveBeenCalled());
  const invoke = (key: string, sender = windows[0]!.webContents, options?: Record<string, unknown>) => {
    const handler = handlers.get(key);
    if (!handler) throw new Error(`Missing IPC handler: ${key}`);
    return handler({ sender }, options);
  };
  return { windows, app, runtime, dialog, shell, writeFileSync, requireModule, start, fakeProcess, invoke };
}

describe("macOS Electron shell", () => {
  it.each([true, false])(
    "starts the %s packaged runtime as a local client with isolated windows",
    async (packaged) => {
      const h = await boot({ packaged });
      expect(h.start).toHaveBeenCalledWith("client");
      expect(h.requireModule).toHaveBeenCalledWith(
        packaged ? "/fake/resources/edexo/app.cjs" : path.resolve("build/app.cjs"),
      );
      expect(h.fakeProcess.env.EDEXO_ELECTRON).toBe("1");
      expect(h.fakeProcess.env.EDEXO_SKIP_DEVENTRY_AUTOSTART).toBe("1");
      expect(h.fakeProcess.env.EDEXO_LEGACY_USER_DATA_DIR).toBe("/fake/userData");
      expect(h.fakeProcess.env.EDEXO_RESOURCES_ROOT).toBe(packaged ? "/fake/resources" : undefined);
      expect(h.windows[0]!.loadURL).toHaveBeenCalledWith("http://127.0.0.1:7111/launcher.html");
      expect(h.windows[0]!.options.webPreferences).toMatchObject({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.resolve("electron/preload.mac.cjs"),
      });
      expect(h.requireModule.mock.calls.map(([name]) => name)).not.toEqual(
        expect.arrayContaining(["./hudWindows.cjs", "./foregroundWatch.cjs", "./tray.cjs", "./keybinds.cjs"]),
      );
    },
  );

  it("reuses the main-app window and recreates it after closing", async () => {
    const h = await boot();
    await h.invoke("edexo:open-app-window");
    expect(h.windows).toHaveLength(2);
    expect(h.windows[1]!.loadURL).toHaveBeenCalledWith("http://127.0.0.1:7111/");
    await h.invoke("edexo:open-app-window");
    expect(h.windows).toHaveLength(2);
    expect(h.windows[1]!.focus).toHaveBeenCalled();
    h.windows[1]!.isDestroyed.mockReturnValue(true);
    await h.invoke("edexo:open-app-window");
    expect(h.windows).toHaveLength(3);
  });

  it("focuses the existing launcher when a second copy starts", async () => {
    const h = await boot();
    h.windows[0]!.isMinimized.mockReturnValue(true);
    h.app.emit("second-instance");
    expect(h.windows[0]!.restore).toHaveBeenCalled();
    expect(h.windows[0]!.show).toHaveBeenCalled();
    expect(h.windows[0]!.focus).toHaveBeenCalled();
    const second = await boot({ lock: false });
    expect(second.app.quit).toHaveBeenCalled();
    expect(second.start).not.toHaveBeenCalled();
    expect(second.windows).toHaveLength(0);
  });

  it("keeps external navigation outside the app, including lookalike local origins", async () => {
    const h = await boot();
    const navigation = h.windows[0]!.webContents;
    for (const url of [
      "https://example.com",
      "http://127.0.0.1:7111.evil.example/",
      "file:///private/export",
    ]) {
      const event = { preventDefault: vi.fn() };
      navigation.emit("will-navigate", event, url);
      expect(event.preventDefault).toHaveBeenCalled();
    }
    expect(h.shell.openExternal.mock.calls).toEqual([
      ["https://example.com"],
      ["http://127.0.0.1:7111.evil.example/"],
    ]);
    const event = { preventDefault: vi.fn() };
    navigation.emit("will-navigate", event, "http://127.0.0.1:7111/");
    expect(event.preventDefault).not.toHaveBeenCalled();
    const open = navigation.setWindowOpenHandler.mock.calls[0]![0];
    expect(open({ url: "http://127.0.0.1:7111/encyclopedia" })).toEqual({ action: "deny" });
    expect(h.windows[1]!.loadURL).toHaveBeenCalledWith("http://127.0.0.1:7111/encyclopedia");
    expect(h.windows[1]!.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false });
    open({ url: "https://example.com/help" });
    expect(h.windows).toHaveLength(2);
    expect(h.shell.openExternal).toHaveBeenCalledWith("https://example.com/help");
  });

  it("allows folder selection, file export and relaunch only from the launcher", async () => {
    const h = await boot();
    await h.invoke("edexo:open-app-window");
    const other = h.windows[1]!.webContents;
    expect(await h.invoke("edexo:pick-folder", other)).toEqual({ path: null });
    expect(await h.invoke("edexo:save-text-file", other, { text: "secret" })).toEqual({ saved: false });
    expect(await h.invoke("edexo:relaunch", other)).toEqual({ ok: false });
    expect(h.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(h.dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(h.app.relaunch).not.toHaveBeenCalled();
    expect(await h.invoke("edexo:pick-folder", undefined, { defaultPath: "/old journal" })).toEqual({
      path: "/chosen journal",
    });
    expect(h.dialog.showOpenDialog).toHaveBeenCalledWith(
      h.windows[0]!,
      expect.objectContaining({ defaultPath: "/old journal" }),
    );
    expect(
      await h.invoke("edexo:save-text-file", undefined, { text: "export", defaultName: "../../unsafe.json" }),
    ).toEqual({ saved: true, path: "/chosen export" });
    expect(h.dialog.showSaveDialog).toHaveBeenCalledWith(h.windows[0]!, {
      defaultPath: "/fake/downloads/unsafe.json",
    });
    expect(h.writeFileSync).toHaveBeenCalledWith("/chosen export", "export", "utf8");
    expect(await h.invoke("edexo:relaunch")).toEqual({ ok: true });
    expect(h.app.relaunch).toHaveBeenCalled();
  });

  it("waits for a running backup, destroys windows and shuts down before quitting", async () => {
    const h = await boot();
    let finishBackup!: () => void;
    h.runtime.backupRunning.mockReturnValue(true);
    h.runtime.whenBackupDone.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishBackup = resolve;
        }),
    );
    const event = { preventDefault: vi.fn() };
    h.app.emit("before-quit", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(h.runtime.whenBackupDone).toHaveBeenCalled();
    expect(h.runtime.shutdown).not.toHaveBeenCalled();
    expect(h.app.quit).not.toHaveBeenCalled();
    finishBackup();
    await vi.waitFor(() => expect(h.app.quit).toHaveBeenCalledOnce());
    expect(h.windows[0]!.destroy).toHaveBeenCalledOnce();
    expect(h.windows[0]!.destroy.mock.invocationCallOrder[0]!).toBeLessThan(
      h.runtime.shutdown.mock.invocationCallOrder[0]!,
    );
    expect(h.runtime.shutdown.mock.invocationCallOrder[0]!).toBeLessThan(
      h.app.quit.mock.invocationCallOrder[0]!,
    );
    h.app.emit("before-quit", { preventDefault: vi.fn() });
    expect(h.runtime.shutdown).toHaveBeenCalledOnce();
  });

  it("quits when all windows close", async () => {
    const h = await boot();
    h.app.emit("window-all-closed");
    expect(h.app.quit).toHaveBeenCalledOnce();
  });
});

describe("macOS Electron entry points", () => {
  it("routes the shared development entry directly to the macOS shell", () => {
    const requireModule = vi.fn((name: string) => {
      if (name !== "./main.mac.cjs") throw new Error(`Loaded platform-specific dependency: ${name}`);
      return {};
    });
    runInNewContext(`(function () { ${readFileSync("electron/main.cjs", "utf8")}\n })();`, {
      require: requireModule,
      process: { platform: "darwin" },
    });
    expect(requireModule).toHaveBeenCalledExactlyOnceWith("./main.mac.cjs");
  });

  it("exposes only the four supported preload operations and forwards their arguments", async () => {
    let bridge!: {
      openAppWindow: () => Promise<unknown>;
      pickFolder: (options: { defaultPath: string }) => Promise<unknown>;
      saveTextFile: (options: { text: string; defaultName: string }) => Promise<unknown>;
      relaunch: () => Promise<unknown>;
    };
    const invoke = vi.fn(async () => ({ ok: true }));
    runInNewContext(readFileSync("electron/preload.mac.cjs", "utf8"), {
      require: (name: string) => {
        if (name !== "electron") throw new Error(`Unexpected preload dependency: ${name}`);
        return {
          ipcRenderer: { invoke },
          contextBridge: {
            exposeInMainWorld: (name: string, api: typeof bridge) => {
              expect(name).toBe("edexoElectron");
              bridge = api;
            },
          },
        };
      },
    });
    expect(Object.keys(bridge).sort()).toEqual(["openAppWindow", "pickFolder", "relaunch", "saveTextFile"]);
    await bridge.openAppWindow();
    await bridge.pickFolder({ defaultPath: "/CrossOver journals" });
    await bridge.saveTextFile({ text: "export", defaultName: "export.json" });
    await bridge.relaunch();
    expect(invoke.mock.calls).toEqual([
      ["edexo:open-app-window"],
      ["edexo:pick-folder", { defaultPath: "/CrossOver journals" }],
      ["edexo:save-text-file", { text: "export", defaultName: "export.json" }],
      ["edexo:relaunch"],
    ]);
  });
});
