import { _electron as electron } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const profile = mkdtempSync(path.join(tmpdir(), "edexo-electron-smoke-"));
const executablePath = path.resolve(
  "dist/electron-out-mac/mac-arm64/EDExoCompare.app/Contents/MacOS/EDExoCompare",
);
const desktop = await electron.launch({
  executablePath,
  args: ["--port", "7139"],
  env: {
    ...process.env,
    ED_JOURNAL_DIR: path.resolve("tests/fixtures/journal-smoke"),
    EDEXO_USER_DATA_DIR: profile,
  },
});
try {
  const launcher = await desktop.firstWindow();
  const errors = [];
  launcher.on("pageerror", (error) => errors.push(String(error)));
  await launcher.waitForSelector("#main.ready");
  assert.equal(await launcher.locator("#btnOverlayMenu, #wzOpenHud").count(), 0);
  const [appWindow] = await Promise.all([
    desktop.waitForEvent("window"),
    launcher.evaluate(() => globalThis.edexoElectron.openAppWindow()),
  ]);
  await appWindow.waitForSelector(".species-card", { timeout: 60_000 });
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);
  assert.deepEqual(errors, []);
  mkdirSync("build-artifacts", { recursive: true });
  await appWindow.screenshot({ path: "build-artifacts/macos-electron.png" });
  console.info("Packaged Electron launcher + predictions passed; no overlay windows.");
} finally {
  // Exercise Cmd+Q shutdown while both windows still have live WebSockets.
  await desktop.evaluate(({ app }) => app.quit()).catch(() => {});
  await desktop.close();
}
