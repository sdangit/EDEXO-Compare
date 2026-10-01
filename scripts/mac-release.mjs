import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { copyDataTree } from "./packagedData.mjs";
import { mergeDataOverlays } from "./mergeDataOverlay.mjs";

/** Shared resource layout for the browser release and Electron's Resources directory. */
export function stageMacResources(dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync("dist/web", join(dest, "web"), { recursive: true });
  for (const file of readdirSync(join(dest, "web"))) {
    if (file.endsWith("-overlay.html") || ["hud", "hud.css", "hud.webmanifest"].includes(file)) {
      rmSync(join(dest, "web", file), { recursive: true, force: true });
    }
  }
  copyDataTree(join(dest, "data"));
  mergeDataOverlays(join(dest, "data"));
  mkdirSync(join(dest, "sql-wasm"), { recursive: true });
  cpSync("node_modules/sql.js/dist/sql-wasm.wasm", join(dest, "sql-wasm/sql-wasm.wasm"));
}
