import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runPkg, writeCliLaunchers } from "./cliPack.mjs";
import { stageMacResources } from "./mac-release.mjs";

if (process.platform !== "darwin") throw new Error("Build the macOS release on a Mac.");
const archIndex = process.argv.indexOf("--arch");
const arch = archIndex < 0 ? process.arch : process.argv[archIndex + 1];
if (!["arm64", "x64"].includes(arch)) throw new Error("Use --arch arm64 or --arch x64.");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const folder = `EDExoCompare-${version}-macos-${arch}`;
const out = join("dist", "mac", folder);
stageMacResources(out);
const { server, client } = writeCliLaunchers();
// Source packaging avoids executing the target Node during bytecode generation (including cross-arch).
const target = `node24-macos-${arch}`;
runPkg("dist:mac", "Server", server, join(out, "edexo-server"), target, ["--no-bytecode", "--public"]);
runPkg("dist:mac", "Client", client, join(out, "edexo-client"), target, ["--no-bytecode", "--public"]);
for (const mode of ["client", "server"]) {
  const file = join(out, `edexo-${mode}.command`);
  writeFileSync(
    file,
    `#!/bin/bash\nset -euo pipefail\ncd -- "$(dirname -- "$0")"\nexec ./edexo-${mode} "$@"\n`,
  );
  chmodSync(file, 0o755);
  chmodSync(join(out, `edexo-${mode}`), 0o755);
}
for (const file of ["LICENSE", "NOTICE.md"]) cpSync(file, join(out, file));
cpSync("data/LICENSE-DATA.txt", join(out, "LICENSE-DATA.txt"));
writeFileSync(
  join(out, "README.txt"),
  `ED Exo Compare ${version} — macOS ${arch}, browser edition

Start Elite Dangerous in CrossOver, then double-click edexo-client.command.
The client opens http://127.0.0.1:7111 in your browser. No Node.js installation is needed.
Keep this whole folder together; Ctrl+C in its Terminal window stops the app.
For settings and backups, open http://127.0.0.1:7111/launcher.html.

Default journals:
~/Library/Application Support/CrossOver/Bottles/Elite Dangerous/drive_c/users/crossover/Saved Games/Frontier Developments/Elite Dangerous
Change Journal folder in the launcher for another bottle, or use:
ED_JOURNAL_DIR="/absolute/path/to/journals" ./edexo-client

Settings: ~/Library/Application Support/ED Exo Compare
HUD overlays and game-process detection are excluded. The game is assumed running;
automatic departure backups use journal Shutdown events, rather than process checks.

Optional LAN mode: edexo-server.command (other devices need the access-key link in the launcher).
Flags: --local, --lan, --port <number>.

This local test build is ad-hoc signed, not Developer ID signed or notarized.
It has been prepared for local testing; downloaded distribution needs Apple signing/notarization.
`,
);
mkdirSync("dist/mac", { recursive: true });
const archive = resolve("dist/mac", `${folder}.tar.gz`);
const tar = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", "dist/mac", folder], { stdio: "inherit" });
if (tar.error) throw tar.error;
if (tar.status !== 0) process.exit(tar.status ?? 1);
console.info(`[dist:mac] ${archive}`);
