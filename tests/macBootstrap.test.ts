import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as presence from "../src/server/gamePresence.js";
import * as backups from "../src/server/backupService.js";
import * as httpServer from "../src/server/httpServer.js";
import { resolveJournalPathsPath } from "../src/server/paths.js";
import { startEdexo, type EdexoRuntime } from "../src/server/edexoBootstrap.js";

let runtime: EdexoRuntime | undefined;
let root: string | undefined;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("macOS bootstrap integration", () => {
  it("avoids process probes, consumes live journals and schedules Shutdown backups with the app connected", async () => {
    root = mkdtempSync(path.join(tmpdir(), "edexo mac bootstrap "));
    const journals = path.join(root, "journals");
    cpSync("tests/fixtures/journal-smoke", journals, { recursive: true });
    vi.stubEnv("ED_JOURNAL_DIR", journals);
    vi.stubEnv("EDEXO_USER_DATA_DIR", path.join(root, "profile"));
    vi.stubEnv("EDEXO_ELECTRON", "1"); // The desktop shell must still avoid polling.
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
    const presenceSpy = vi.spyOn(presence, "createGamePresence");
    const backupSpy = vi.spyOn(backups, "createBackupService");
    const serverSpy = vi.spyOn(httpServer, "createHttpServer");
    runtime = await startEdexo({
      port: 0,
      bindHost: "127.0.0.1",
      shouldOpenMainUI: false,
      quietConsole: true,
      useShellLauncher: false,
    });
    await runtime.ready;
    expect(presenceSpy).toHaveBeenCalledWith({ autoStart: false });
    const backupOptions = backupSpy.mock.calls[0]![0];
    expect(backupOptions.isGameRunning).toBeTypeOf("function");
    expect(await backupOptions.isGameRunning!()).toBe(true);
    const service = backupSpy.mock.results[0]!.value as backups.BackupService;
    service.setSettings({ folder: path.join(root, "backups"), onLeaveGame: true });
    const server = serverSpy.mock.results[0]!.value as ReturnType<typeof httpServer.createHttpServer>;
    await server.listening;
    const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    await vi.waitFor(
      async () => {
        const state = await (await fetch(`${base}/api/state`)).json();
        expect(state.journalDir).toBe(journals);
        expect(state.bodies.length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    // Changing bottles must persist the choice and restart the live watcher.
    const alternate = path.join(root, "other CrossOver bottle", "journals");
    cpSync("tests/fixtures/journal-smoke", alternate, { recursive: true });
    const changed = await fetch(`${base}/api/settings/journal-directory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ journalDir: alternate }),
    });
    expect(changed.status).toBe(200);
    expect(JSON.parse(readFileSync(resolveJournalPathsPath(), "utf8")).journalDir).toBe(alternate);
    expect(backupOptions.getJournalDir()).toBe(alternate);
    await vi.waitFor(async () => {
      const state = await (await fetch(`${base}/api/state`)).json();
      expect(state.journalDir).toBe(alternate);
      expect(state.bodies.length).toBeGreaterThan(0);
    });
    expect(runtime.gameRunning()).toBeNull(); // No initial process-list result.
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
    try {
      const initial = once(ws, "message");
      await once(ws, "open");
      await initial;
      const journal = path.join(alternate, "Journal.2026-09-13T100000.01.log");
      appendFileSync(
        journal,
        JSON.stringify({ timestamp: new Date().toISOString(), event: "Shutdown" }) + "\n",
      );
      await vi.waitFor(async () => expect((await service.status()).pendingAt).not.toBeNull(), {
        timeout: 10_000,
      });
      expect(runtime.gameRunning()).toBe(false); // Journal events still reach presence tracking.
      expect((await service.status()).running).toBe(false);
      const closed = once(ws, "close");
      await runtime.shutdown();
      runtime = undefined;
      await closed;
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      ws.terminate();
    }
  });
});
