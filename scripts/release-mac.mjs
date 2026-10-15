import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "sdangit/EDEXO-Compare";
const GH_REPO = `github.com/${REPO}`;
const ORIGIN = `https://github.com/${REPO}.git`;

function execute(command, args, { cwd = ROOT, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}). ${result.stderr || ""}`.trim());
  return result.stdout?.trim() || "";
}

async function checksum(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Build, validate and stage only; publication is always a separate GitHub action. */
export async function releaseMac({
  root = ROOT,
  run = execute,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
} = {}) {
  if (platform !== "darwin" || !["arm64", "x64"].includes(arch))
    throw new Error(
      "Run release:mac on an Apple Silicon or Intel Mac; only the host architecture is released.",
    );
  const [major, minor] = nodeVersion.split(".").map(Number);
  if (major !== 24 || minor < 15)
    throw new Error("Use Node 24.15 or newer in the Node 24 series (nvm use 24).");
  const cmd = (command, args, capture = false) => run(command, args, { cwd: root, capture });
  const git = (...args) => cmd("git", args, true);
  const gh = (...args) => cmd("gh", args, true);
  const npm = (...args) => cmd("npm", args);
  const assertClean = (head) => {
    if (git("branch", "--show-current") !== "macos")
      throw new Error("Integrate the work into macos before staging a release.");
    if (git("status", "--porcelain", "--untracked-files=all"))
      throw new Error("Commit all changes before staging a release.");
    if (head && git("rev-parse", "HEAD") !== head)
      throw new Error("HEAD changed during the release; rerun release:mac.");
  };
  const assertOrigin = () => {
    cmd("git", ["remote", "-v"]);
    for (const args of [
      ["remote", "get-url", "origin"],
      ["remote", "get-url", "--push", "origin"],
    ]) {
      if (git(...args) !== ORIGIN) throw new Error(`origin must fetch and push ${ORIGIN}`);
    }
  };
  assertClean();
  assertOrigin();
  const head = git("rev-parse", "HEAD");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("package.json must use the upstream x.y.z version.");
  const appVersion = readFileSync(join(root, "src/server/appVersion.ts"), "utf8");
  if (!appVersion.includes(`export const APP_VERSION = "${version}";`))
    throw new Error("package.json and src/server/appVersion.ts must have the same version.");
  const tag = `v${version}-macos`;
  // Verify credentials before spending time building; never print or read the token itself.
  gh("api", "user", "--hostname", "github.com", "--jq", ".login");
  const getRelease = () => {
    const pages = JSON.parse(
      gh("api", `repos/${REPO}/releases?per_page=100`, "--hostname", "github.com", "--paginate", "--slurp"),
    );
    return pages.flat().find((release) => release.tag_name === tag);
  };
  const assertDraft = (release) => {
    if (!release) return;
    if (!release.draft) throw new Error(`${tag} is already published; it will not be changed.`);
    if (release.target_commitish !== head)
      throw new Error(`${tag} is a draft for a different commit; review it on GitHub first.`);
    if (release.prerelease) throw new Error(`${tag} must be a regular release, not a prerelease.`);
  };
  const assertTag = () => {
    const refs = git("ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
    const entries = refs ? refs.split("\n").map((line) => line.split(/\s+/)) : [];
    const commit = (entries.find((entry) => entry[1].endsWith("^{}")) || entries[0])?.[0];
    if (commit && commit !== head)
      throw new Error(`${tag} already points to a different commit; it will not be moved.`);
  };
  assertDraft(getRelease());
  assertTag();

  for (const args of [
    ["ci"],
    ["test"],
    ["run", "typecheck"],
    ["run", "lint"],
    ["run", "dist:mac"],
    ["run", "test:e2e:mac"],
    ["run", "dist:mac:electron"],
    ["run", "test:electron:mac"],
  ])
    npm(...args);

  // Only the exact, clean commit used for the builds can be pushed and attached to the draft.
  assertClean(head);
  assertOrigin();
  const files = [
    join(root, "dist/electron-out-mac", `EDExoCompare-${version}-macos-${arch}.zip`),
    join(root, "dist/mac", `EDExoCompare-${version}-macos-${arch}.tar.gz`),
  ];
  const artifacts = [];
  for (const file of files) {
    const size = statSync(file).size;
    if (size === 0) throw new Error(`Empty release artifact: ${file}`);
    artifacts.push({ file, name: basename(file), size, digest: `sha256:${await checksum(file)}` });
  }
  const staging = join(root, "dist/mac-release");
  mkdirSync(staging, { recursive: true });
  const sums = join(staging, `SHA256SUMS-${arch}.txt`);
  writeFileSync(sums, artifacts.map((asset) => `${asset.digest.slice(7)}  ${asset.name}\n`).join(""));
  artifacts.push({
    file: sums,
    name: basename(sums),
    size: statSync(sums).size,
    digest: `sha256:${await checksum(sums)}`,
  });
  const notes = join(staging, "release-notes.md");
  writeFileSync(
    notes,
    `Personal-use macOS builds based on upstream **v${version}**. These builds are not notarized.

## Downloads and installation

- Download the ZIP matching your Mac: **arm64** for Apple Silicon or **x64** for Intel. Only the attached architectures are available.
- Quit EDExoCompare, extract the ZIP, and move EDExoCompare.app to Applications, replacing the previous copy.
- The optional tar.gz is the self-contained browser edition; extract it and run edexo-client.command. Keep its Terminal open.
- Start Elite Dangerous in CrossOver first. Settings and commander data remain in the existing user data folder.
- Application updates open this fork's release page for manual installation.

## Changes and verification

[Upstream changes for v${version}](https://github.com/bahuckel/EDEXO-Compare/releases/tag/v${version}). The app's What's new panel shows upstream notes; there is no separate port changelog.

Source: [${head}](https://github.com/${REPO}/commit/${head}). Unit tests, typecheck, lint, and extracted browser and Electron release smoke tests passed on the build Mac. SHA-256 checksums are attached.
`,
  );

  assertClean(head);
  cmd("git", ["push", "origin", `${head}:refs/heads/macos`]);
  assertTag();
  const existing = getRelease();
  assertDraft(existing);
  if (!existing) {
    cmd("gh", [
      "release",
      "create",
      tag,
      "--repo",
      GH_REPO,
      "--target",
      head,
      "--draft",
      "--title",
      `ED Exo Compare ${version} — macOS`,
      "--notes-file",
      notes,
    ]);
  }
  // A retry may replace only this architecture's files in the same unpublished draft.
  const draft = getRelease();
  if (!draft) throw new Error("The new draft could not be read back; rerun release:mac.");
  assertDraft(draft);
  cmd("gh", [
    "release",
    "upload",
    tag,
    ...artifacts.map((asset) => asset.file),
    "--repo",
    GH_REPO,
    "--clobber",
  ]);
  const release = getRelease();
  if (!release) throw new Error("The uploaded draft could not be read back.");
  assertDraft(release);
  for (const asset of artifacts) {
    const uploaded = release.assets.find((candidate) => candidate.name === asset.name);
    if (
      !uploaded ||
      uploaded.state !== "uploaded" ||
      uploaded.size !== asset.size ||
      uploaded.digest !== asset.digest
    )
      throw new Error(
        `Draft asset verification failed for ${asset.name}; rerun release:mac before publishing.`,
      );
  }
  console.info(`\nDraft ready for review and publication:\n${release.html_url}`);
  try {
    cmd("gh", ["release", "view", tag, "--repo", GH_REPO, "--web"]);
  } catch {
    console.info("Open the link above to review the draft.");
  }
  return release.html_url;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error("Usage: npm run release:mac (builds this Mac's architecture and creates a draft only)");
    process.exitCode = 1;
  } else {
    releaseMac().catch((error) => {
      console.error(`[release:mac] ${error.message}`);
      process.exitCode = 1;
    });
  }
}
