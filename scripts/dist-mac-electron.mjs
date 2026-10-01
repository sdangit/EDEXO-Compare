import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
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
