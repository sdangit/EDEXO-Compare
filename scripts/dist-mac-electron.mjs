import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { stageMacResources } from "./mac-release.mjs";

if (process.platform !== "darwin") throw new Error("Build the macOS app on a Mac.");
const archIndex = process.argv.indexOf("--arch");
const arch = archIndex < 0 ? process.arch : process.argv[archIndex + 1];
if (!["arm64", "x64"].includes(arch)) throw new Error("Use --arch arm64 or --arch x64.");
stageMacResources("dist/mac-staging");
const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [
    require.resolve("electron-builder/cli.js"),
    "--mac",
    "dir",
    `--${arch}`,
    "--config",
    "electron-builder.mac.cjs",
    "--publish",
    "never",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Preserve the .app bundle metadata in the archive used for manual fork releases.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const app = resolve("dist/electron-out-mac", arch === "arm64" ? "mac-arm64" : "mac", "EDExoCompare.app");
const archive = resolve("dist/electron-out-mac", `EDExoCompare-${version}-macos-${arch}.zip`);
rmSync(archive, { force: true });
const zip = spawnSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive], {
  stdio: "inherit",
});
if (zip.error) throw zip.error;
if (zip.status !== 0) process.exit(zip.status ?? 1);
console.info(`[dist:mac:electron] ${archive}`);
