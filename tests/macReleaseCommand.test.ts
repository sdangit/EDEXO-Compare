import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — the release command is a plain Node .mjs script
import { releaseMac } from "../scripts/release-mac.mjs";

const HEAD = "a".repeat(40);
const ORIGIN = "https://github.com/sdangit/EDEXO-Compare.git";
interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  target_commitish: string;
  html_url: string;
  assets: { name: string; state: string; size: number; digest: string }[];
}
const draft = (): Release => ({
  tag_name: "v1.2.17-macos",
  draft: true,
  prerelease: false,
  target_commitish: HEAD,
  html_url: "https://github.com/sdangit/EDEXO-Compare/releases/tag/draft-test",
  assets: [],
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), "edexo draft release "));
  roots.push(root);
  mkdirSync(join(root, "src/server"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.17" }));
  writeFileSync(join(root, "src/server/appVersion.ts"), 'export const APP_VERSION = "1.2.17";');
  const state = {
    branch: "macos",
    dirty: "",
    origin: ORIGIN,
    head: HEAD,
    tag: "",
    release: undefined as Release | undefined,
    fail: "",
    corrupt: false,
  };
  const calls: { command: string; args: string[] }[] = [];
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (`${command} ${args.join(" ")}` === state.fail) throw new Error("simulated command failure");
    if (command === "git") {
      if (args[0] === "branch") return state.branch;
      if (args[0] === "status") return state.dirty;
      if (args[0] === "rev-parse") return state.head;
      if (args[0] === "remote" && args[1] === "get-url") return state.origin;
      if (args[0] === "ls-remote") return state.tag;
    }
    if (command === "npm" && args[1]?.startsWith("dist:mac")) {
      const file =
        args[1] === "dist:mac:electron"
          ? join(root, "dist/electron-out-mac/EDExoCompare-1.2.17-macos-arm64.zip")
          : join(root, "dist/mac/EDExoCompare-1.2.17-macos-arm64.tar.gz");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `fake artifact ${basename(file)}`);
    }
    if (command === "gh") {
      if (args[0] === "api" && args[1]!.includes("/releases?"))
        return JSON.stringify([state.release ? [state.release] : []]);
      if (args[0] === "release" && args[1] === "create") state.release = draft();
      if (args[0] === "release" && args[1] === "upload") {
        state.release!.assets = args.slice(3, args.indexOf("--repo")).map((file) => {
          const data = readFileSync(file);
          return {
            name: basename(file),
            state: "uploaded",
            size: data.length,
            digest: state.corrupt ? "wrong" : `sha256:${createHash("sha256").update(data).digest("hex")}`,
          };
        });
      }
    }
    return "";
  };
  const start = (extra = {}) =>
    releaseMac({ root, run, platform: "darwin", arch: "arm64", nodeVersion: "24.15.0", ...extra });
  return { root, state, calls, start };
}

describe("the macOS draft release command", () => {
  it("runs all checks before pushing the tested commit and uploads only a verified draft", async () => {
    const h = harness();
    expect(await h.start()).toBe(draft().html_url);
    expect(h.calls.filter((call) => call.command === "npm").map((call) => call.args)).toEqual([
      ["ci"],
      ["test"],
      ["run", "typecheck"],
      ["run", "lint"],
      ["run", "dist:mac"],
      ["run", "test:e2e:mac"],
      ["run", "dist:mac:electron"],
      ["run", "test:electron:mac"],
    ]);
    const push = h.calls.findIndex((call) => call.args[0] === "push");
    expect(push).toBeGreaterThan(h.calls.findIndex((call) => call.args[1] === "test:electron:mac"));
    expect(h.calls[push]!.args).toEqual(["push", "origin", `${HEAD}:refs/heads/macos`]);
    const create = h.calls.find((call) => call.command === "gh" && call.args[1] === "create")!;
    expect(create.args).toContain("--draft");
    expect(create.args[create.args.indexOf("--target") + 1]).toBe(HEAD);
    expect(create.args[create.args.indexOf("--repo") + 1]).toBe("github.com/sdangit/EDEXO-Compare");
    expect(h.state.release!.draft).toBe(true);
    expect(h.state.release!.assets.map((asset) => asset.name)).toEqual([
      "EDExoCompare-1.2.17-macos-arm64.zip",
      "EDExoCompare-1.2.17-macos-arm64.tar.gz",
      "SHA256SUMS-arm64.txt",
    ]);
    const notes = readFileSync(join(h.root, "dist/mac-release/release-notes.md"), "utf8");
    expect(notes).toContain(`/commit/${HEAD}`);
    expect(notes).toContain("/bahuckel/EDEXO-Compare/releases/tag/v1.2.17");
  });

  it("resumes an interrupted draft for the same commit", async () => {
    const h = harness();
    h.state.release = draft();
    await h.start();
    expect(h.calls.some((call) => call.command === "gh" && call.args[1] === "create")).toBe(false);
    expect(h.state.release.assets).toHaveLength(3);
  });

  it.each(["published", "different commit", "prerelease"])(
    "rejects an existing %s release before building",
    async (kind) => {
      const h = harness();
      h.state.release = draft();
      if (kind === "published") h.state.release.draft = false;
      if (kind === "different commit") h.state.release.target_commitish = "b".repeat(40);
      if (kind === "prerelease") h.state.release.prerelease = true;
      await expect(h.start()).rejects.toThrow();
      expect(h.calls.some((call) => call.command === "npm")).toBe(false);
    },
  );

  it.each(["branch", "dirty", "origin", "tag"])("rejects an unsafe %s before building", async (key) => {
    const h = harness();
    if (key === "branch") h.state.branch = "main";
    if (key === "dirty") h.state.dirty = " M package.json";
    if (key === "origin") h.state.origin = "https://github.com/bahuckel/EDEXO-Compare.git";
    if (key === "tag") h.state.tag = `${"b".repeat(40)}\trefs/tags/v1.2.17-macos`;
    await expect(h.start()).rejects.toThrow();
    expect(h.calls.some((call) => call.command === "npm")).toBe(false);
  });

  it("stops at a failed smoke check without pushing or creating a release", async () => {
    const h = harness();
    h.state.fail = "npm run test:e2e:mac";
    await expect(h.start()).rejects.toThrow("simulated");
    expect(h.calls.some((call) => call.args[0] === "push" || call.args[1] === "create")).toBe(false);
  });

  it("stops at a rejected push without creating a release", async () => {
    const h = harness();
    h.state.fail = `git push origin ${HEAD}:refs/heads/macos`;
    await expect(h.start()).rejects.toThrow("simulated");
    expect(h.state.release).toBeUndefined();
  });

  it("does not report a draft ready when uploaded checksums differ", async () => {
    const h = harness();
    h.state.corrupt = true;
    await expect(h.start()).rejects.toThrow("verification failed");
    expect(h.calls.some((call) => call.args.includes("--web"))).toBe(false);
  });

  it.each([{ platform: "linux" }, { nodeVersion: "26.0.0" }, { nodeVersion: "24.14.0" }, { arch: "ia32" }])(
    "rejects unsupported build environments (%j)",
    async (extra) => {
      const h = harness();
      await expect(h.start(extra)).rejects.toThrow();
      expect(h.calls).toEqual([]);
    },
  );
});
