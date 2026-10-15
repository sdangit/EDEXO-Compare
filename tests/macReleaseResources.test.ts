import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("stages macOS resources without HUDs or commander data and replaces stale releases", () => {
  const root = mkdtempSync(path.join(tmpdir(), "edexo mac staging "));
  const write = (name: string, content = "fixture") => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  try {
    for (const file of [
      "index.html",
      "launcher.html",
      "hud.css",
      "hud.webmanifest",
      "hud-overlay.html",
      "distance-overlay.html",
      "hud/main.js",
      "assets/app.js",
    ])
      write(`dist/web/${file}`);
    write("data/species/species.json");
    write("data/foot_scanned.json", "private commander fixture");
    write("data/spansh-dump-tests/export.json");
    write("node_modules/sql.js/dist/sql-wasm.wasm", "wasm fixture");
    write("out/stale-file");
    const module = pathToFileURL(path.resolve("scripts/mac-release.mjs")).href;
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { stageMacResources } from ${JSON.stringify(module)}; stageMacResources("out");`,
      ],
      {
        cwd: root,
        env: { ...process.env, EDEXO_DATA_OVERLAY: "" },
      },
    );
    const out = path.join(root, "out");
    expect(readdirSync(path.join(out, "web")).sort()).toEqual(["assets", "index.html", "launcher.html"]);
    expect(readFileSync(path.join(out, "web/assets/app.js"), "utf8")).toBe("fixture");
    expect(readFileSync(path.join(out, "data/species/species.json"), "utf8")).toBe("fixture");
    expect(readFileSync(path.join(out, "sql-wasm/sql-wasm.wasm"), "utf8")).toBe("wasm fixture");
    for (const file of ["stale-file", "data/foot_scanned.json", "data/spansh-dump-tests"])
      expect(existsSync(path.join(out, file)), file).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
