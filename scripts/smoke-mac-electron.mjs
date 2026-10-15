import { _electron as electron } from "@playwright/test";
import { cpSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const profile = mkdtempSync(path.join(tmpdir(), "edexo-electron-smoke-"));
const journals = path.join(profile, "journals");
cpSync("tests/fixtures/journal-smoke", journals, { recursive: true });
const env = { ...process.env, ED_JOURNAL_DIR: journals, EDEXO_USER_DATA_DIR: profile };
// Codex and other Node hosts may set this; the release must run as a desktop app.
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = path.resolve(
  "dist/electron-out-mac/mac-arm64/EDExoCompare.app/Contents/MacOS/EDExoCompare",
);
const desktop = await electron.launch({
  executablePath,
  args: ["--port", "7139"],
  env,
});
try {
  const launcher = await desktop.firstWindow();
  const errors = [];
  desktop.on("window", (window) => window.on("pageerror", (error) => errors.push(String(error))));
  launcher.on("pageerror", (error) => errors.push(String(error)));
  await launcher.waitForSelector("#main.ready");
  assert.equal(await launcher.locator("#btnOverlayMenu, #wzOpenHud, #btnKeybinds, #keybindsModal").count(), 0);
  const [appWindow] = await Promise.all([
    desktop.waitForEvent("window"),
    launcher.evaluate(() => globalThis.edexoElectron.openAppWindow()),
  ]);
  await appWindow.waitForSelector(".species-card, .srow", { timeout: 60_000 });
  await launcher.evaluate(() => globalThis.edexoElectron.openAppWindow());
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);
  const preferences = await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.webContents.getLastWebPreferences()),
  );
  for (const prefs of preferences) {
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.sandbox, true);
  }
  assert.deepEqual(await launcher.evaluate(() => Object.keys(globalThis.edexoElectron).sort()), [
    "openAppWindow",
    "pickFolder",
    "relaunch",
    "saveTextFile",
  ]);
  await appWindow.close();
  const [reopened] = await Promise.all([
    desktop.waitForEvent("window"),
    launcher.evaluate(() => globalThis.edexoElectron.openAppWindow()),
  ]);
  await reopened.waitForSelector(".species-card, .srow", { timeout: 60_000 });
  assert.deepEqual(errors, []);
  mkdirSync("build-artifacts", { recursive: true });
  await reopened.screenshot({ path: "build-artifacts/macos-electron.png" });
  console.info("Packaged Electron launcher + predictions passed; no overlay windows.");
} finally {
  // Exercise Cmd+Q shutdown while both windows still have live WebSockets.
  await desktop.evaluate(({ app }) => app.quit()).catch(() => {});
  await desktop.close();
}
