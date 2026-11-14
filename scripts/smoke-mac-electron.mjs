import { _electron as electron, expect } from "@playwright/test";
import { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } from "@electron/fuses";
import { FuseState } from "@electron/fuses/dist/constants.js";
import { cpSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const profile = mkdtempSync(path.join(tmpdir(), "edexo-electron-smoke-"));
const journals = path.join(profile, "journals");
cpSync("tests/fixtures/journal-smoke", journals, { recursive: true });
const env = { ...process.env, ED_JOURNAL_DIR: journals, EDEXO_USER_DATA_DIR: profile };
// Codex and other Node hosts may set this; the release must run as a desktop app.
delete env.ELECTRON_RUN_AS_NODE;
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const extracted = mkdtempSync(path.join(tmpdir(), "edexo Mac app release "));
execFileSync("/usr/bin/ditto", [
  "-x",
  "-k",
  path.resolve("dist/electron-out-mac", `EDExoCompare-${version}-macos-${process.arch}.zip`),
  extracted,
]);
const executablePath = path.join(extracted, "EDExoCompare.app/Contents/MacOS/EDExoCompare");
const appPath = path.join(extracted, "EDExoCompare.app");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
const fuses = await getCurrentFuseWire(appPath);
for (const fuse of [
  FuseV1Options.RunAsNode,
  FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  FuseV1Options.EnableNodeCliInspectArguments,
]) assert.equal(fuses[fuse], FuseState.DISABLE);

// First boot the unmodified archive: Playwright's Electron driver needs --inspect, which releases disable.
const release = spawn(executablePath, ["--port", "7139"], { env, stdio: "ignore" });
const exited = once(release, "exit");
try {
  await expect.poll(async () => {
    assert.equal(release.exitCode, null, "The unmodified release exited before serving its launcher");
    assert.equal(release.signalCode, null, "The unmodified release was killed before serving its launcher");
    try {
      const response = await fetch("http://127.0.0.1:7139/launcher.html", { signal: AbortSignal.timeout(1000) });
      return response.ok && (await response.text()).includes("id=\"main\"");
    } catch {
      return false;
    }
  }, { timeout: 60_000 }).toBe(true);
  console.info("Unmodified Electron release booted with all three hardening fuses disabled.");
} finally {
  release.kill();
  await exited;
}

// Instrument only this throwaway extraction. The built .app and release ZIP remain hardened.
await flipFuses(appPath, {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: true,
  [FuseV1Options.EnableNodeCliInspectArguments]: true,
});
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
  const update = await launcher.evaluate(async () => (await fetch("/api/app/update")).json());
  assert.equal(update.form, "macos-app");
  assert.equal(update.download.supported, false);
  if (update.pageUrl)
    assert.ok(update.pageUrl.startsWith("https://github.com/sdangit/EDEXO-Compare/releases/tag/"));
  assert.equal(
    await launcher.locator("#btnOverlayMenu, #wzOpenHud, #btnKeybinds, #keybindsModal").count(),
    0,
  );
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
