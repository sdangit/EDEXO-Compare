/**
 * Every build ships its licences (review 2026-11-10 E4, plan 2.7): LICENSE, NOTICE.md, the data licence and the
 * bundled libraries' own licence texts, which NOTICE.md says travel with the app and no Windows build carried.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a build script, plain ESM without types
import { BUNDLED_ROOTS, bundledPackages, thirdPartyLicencesText } from "../scripts/thirdPartyLicences.mjs";

const require = createRequire(import.meta.url);

describe("the shipped licences", () => {
  it("are beside the exe in the Windows build", () => {
    const cfg = require("../electron-builder.cjs") as { extraFiles: { from: string; to: string }[] };
    expect(cfg.extraFiles.map((f) => f.to).sort()).toEqual(["LICENSE-DATA.txt", "LICENSE.txt", "NOTICE.md", "THIRD-PARTY-LICENSES.txt"]);
  });

  it("are in Resources in the signed macOS app", () => {
    const cfg = require("../electron-builder.mac.cjs") as {
      extraFiles: unknown[];
      extraResources: { from: string; to: string }[];
    };
    expect(cfg.extraFiles).toEqual([]);
    expect(cfg.extraResources.map((f) => f.to)).toEqual(expect.arrayContaining([
      "LICENSE-DATA.txt", "LICENSE.txt", "NOTICE.md", "THIRD-PARTY-LICENSES.txt",
    ]));
  });

  it("are in the CLI pack and the Linux and macOS browser builds", () => {
    for (const f of ["scripts/dist-win-cli.mjs", "scripts/dist-linux.mjs", "scripts/dist-mac.mjs"])
      expect([f, readFileSync(f, "utf8").includes("THIRD-PARTY-LICENSES.txt")]).toEqual([f, true]);
  });

  it("name every library NOTICE.md lists as bundled, each with its licence text", () => {
    const names = (bundledPackages() as { name: string }[]).map((p) => p.name);
    for (const r of (BUNDLED_ROOTS as string[]).filter((x) => !x.endsWith("/*"))) expect(names).toContain(r);
    const text = thirdPartyLicencesText() as string;
    expect(text).toMatch(/={78}\nreact \d+\.\d+\.\d+ — MIT\n={78}\nMIT License/);
    expect(text).not.toContain("licence file not found");
  });
});
