import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const folder = `EDExoCompare-${version}-macos-${process.arch}`;
// Exercise the extracted archive, outside the checkout, including a path with spaces.
const root = mkdtempSync(path.join(tmpdir(), "edexo mac release "));
execFileSync("/usr/bin/tar", ["-xzf", path.resolve("dist/mac", `${folder}.tar.gz`), "-C", root]);
const journalDir = path.join(root, "journals");
cpSync("tests/fixtures/journal-smoke", journalDir, { recursive: true });
const executable = path.join(root, folder, "edexo-server.command");
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export default defineConfig({
  testDir: "e2e-mac",
  timeout: 60_000,
  workers: 1,
  metadata: { journalDir, releaseDir: path.join(root, folder) },
  outputDir: "build-artifacts/playwright-mac",
  use: { baseURL: "http://127.0.0.1:7129", channel: "chrome", headless: true, trace: "retain-on-failure" },
  webServer: {
    command: `${quote(executable)} --local --port 7129`,
    cwd: tmpdir(),
    url: "http://127.0.0.1:7129/api/status",
    reuseExistingServer: false,
    timeout: 60_000,
    env: { ...process.env, ED_JOURNAL_DIR: journalDir, EDEXO_USER_DATA_DIR: path.join(root, "profile") },
  },
});
