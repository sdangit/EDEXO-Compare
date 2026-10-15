import { describe, expect, it, vi } from "vitest";
import {
  createMacUpdateChecker,
  currentMacReleaseForm,
  MAC_RELEASES_API,
  MAC_RELEASES_PAGE,
  pickLatestMacRelease,
} from "../src/server/macUpdateCheck.js";

const release = (version: string, files: string[] = ["arm64.zip"], extra = {}) => ({
  tag_name: `v${version}-macos`,
  draft: false,
  prerelease: false,
  published_at: "2026-10-14T12:00:00Z",
  assets: files.map((file) => ({
    name: `EDExoCompare-${version}-macos-${file}`,
    state: "uploaded",
    size: 123,
  })),
  ...extra,
});

describe("Mac release eligibility", () => {
  it("selects the architecture and app/browser format independently, skipping missing releases", () => {
    const releases = [
      release("1.2.20", ["x64.zip"]),
      release("1.2.19", ["arm64.tar.gz"]),
      release("1.2.17", ["arm64.zip", "x64.tar.gz"]),
    ];
    expect(pickLatestMacRelease(releases, "macos-app", "arm64")?.version).toBe("1.2.17");
    expect(pickLatestMacRelease(releases, "macos-app", "x64")?.version).toBe("1.2.20");
    expect(pickLatestMacRelease(releases, "macos-browser", "arm64")?.version).toBe("1.2.19");
    expect(pickLatestMacRelease(releases, "macos-browser", "x64")?.version).toBe("1.2.17");
    expect(pickLatestMacRelease(releases, "macos-app", "ia32")).toBeNull();
  });

  it("ignores drafts, prereleases, upstream tags and incomplete uploads", () => {
    const releases = [
      release("2.0.0", undefined, { draft: true }),
      release("1.9.0", undefined, { prerelease: true }),
      release("1.8.0", undefined, { tag_name: "v1.8.0" }),
      release("1.7.0", undefined, { tag_name: "v1.7.0-zip" }),
      release("1.6.0", undefined, {
        assets: [{ name: "EDExoCompare-1.6.0-macos-arm64.zip", state: "new", size: 123 }],
      }),
      release("1.5.0", undefined, {
        assets: [{ name: "EDExoCompare-1.5.0-macos-arm64.zip", state: "uploaded", size: 0 }],
      }),
      release("1.4.0", undefined, { assets: null }),
      release("1.2.17"),
    ];
    expect(pickLatestMacRelease(releases, "macos-app", "arm64")?.version).toBe("1.2.17");
  });

  it("compares versions numerically and constructs only a fork release-page URL", () => {
    const releases = [
      release("1.2.9", undefined, { html_url: "https://example.com/untrusted" }),
      release("1.2.17"),
    ];
    expect(pickLatestMacRelease(releases, "macos-app", "arm64")).toMatchObject({
      version: "1.2.17",
      pageUrl: `${MAC_RELEASES_PAGE}/tag/v1.2.17-macos`,
    });
    expect(pickLatestMacRelease({}, "macos-app", "arm64")).toBeNull();
  });

  it("identifies Electron separately from source/browser runs without Windows environment fallbacks", () => {
    expect(currentMacReleaseForm({ EDEXO_ELECTRON: "1" })).toBe("macos-app");
    expect(currentMacReleaseForm({ PORTABLE_EXECUTABLE_FILE: "old.exe", APPIMAGE: "old.AppImage" })).toBe(
      "macos-browser",
    );
  });
});

describe("Mac update notifications", () => {
  const make = (body: unknown, current = "1.2.17") => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body)));
    const checker = createMacUpdateChecker({ fetchImpl, current, form: "macos-app", arch: "arm64" });
    return { fetchImpl, checker };
  };

  it("asks only the fork and offers a manual page across skipped upstream versions", async () => {
    const { checker, fetchImpl } = make([release("1.2.20")]);
    expect(await checker.check()).toMatchObject({
      current: "1.2.17",
      latest: "1.2.20",
      newer: true,
      form: "macos-app",
      error: null,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      MAC_RELEASES_API,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(checker.updatePageUrl()).toBe(`${MAC_RELEASES_PAGE}/tag/v1.2.20-macos`);
  });

  it.each([
    { releases: [] },
    { releases: [release("1.2.20", ["x64.zip"])] },
    { releases: [release("1.2.20", undefined, { tag_name: "v1.2.20-zip" })] },
  ])("treats no compatible published release as a successful empty check (%j)", async ({ releases }) => {
    const { checker } = make(releases);
    expect(await checker.check()).toMatchObject({ latest: null, newer: false, pageUrl: null, error: null });
    expect(checker.updatePageUrl()).toBeNull();
  });

  it.each(["1.2.17", "1.2.20"])("does not offer a reinstall or downgrade from %s", async (current) => {
    const { checker } = make([release("1.2.17")], current);
    expect((await checker.check()).newer).toBe(false);
    expect(checker.updatePageUrl()).toBeNull();
  });

  it("memoises even at time zero, coalesces concurrent checks and supports a forced refresh", async () => {
    let time = 0;
    const fetchImpl = vi.fn(async () => new Response("[]"));
    const checker = createMacUpdateChecker({ fetchImpl, now: () => time });
    const first = checker.check();
    expect(checker.check(true)).toBe(first);
    await first;
    time = 30 * 60 * 1000;
    await checker.check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await checker.check(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    time += 61 * 60 * 1000;
    await checker.check();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps a previous good answer on network failure, and rejects malformed responses", async () => {
    const { checker, fetchImpl } = make([release("1.2.20")]);
    await checker.check();
    fetchImpl.mockRejectedValueOnce(new Error("offline"));
    expect(await checker.check(true)).toMatchObject({ latest: "1.2.20", newer: true, error: "offline" });
    fetchImpl.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    expect((await checker.check(true)).error).toContain("403");
    expect((await make({}).checker.check()).error).toContain("invalid release list");
    expect((await make({}).checker.check()).latest).toBeNull();
  });
});
