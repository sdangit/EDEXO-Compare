/** Manual macOS updates come only from this fork's published, compatible release assets. */
import type { UpdateInfoDTO } from "../shared/types.js";
import { APP_USER_AGENT, APP_VERSION } from "./appVersion.js";
import { compareVersions } from "./updateCheck.js";

export const MAC_RELEASES_API = "https://api.github.com/repos/sdangit/EDEXO-Compare/releases?per_page=100";
export const MAC_RELEASES_PAGE = "https://github.com/sdangit/EDEXO-Compare/releases";
export type MacReleaseForm = "macos-app" | "macos-browser";

export function currentMacReleaseForm(env: NodeJS.ProcessEnv = process.env): MacReleaseForm {
  return env.EDEXO_ELECTRON === "1" ? "macos-app" : "macos-browser";
}

interface MacRelease {
  version: string;
  pageUrl: string;
  publishedAt: string | null;
}

/** A tag alone is insufficient: the asset for this architecture and build must be uploaded. */
export function pickLatestMacRelease(
  releases: unknown,
  form: MacReleaseForm,
  arch: string,
): MacRelease | null {
  if (!Array.isArray(releases) || !["arm64", "x64"].includes(arch)) return null;
  let best: MacRelease | null = null;
  for (const release of releases as Record<string, unknown>[]) {
    if (
      !release ||
      release.draft === true ||
      release.prerelease === true ||
      typeof release.tag_name !== "string"
    )
      continue;
    const tag = /^v(\d+\.\d+\.\d+)-macos$/.exec(release.tag_name);
    if (!tag || !Array.isArray(release.assets)) continue;
    const version = tag[1]!;
    const extension = form === "macos-app" ? "zip" : "tar.gz";
    const name = `EDExoCompare-${version}-macos-${arch}.${extension}`;
    const compatible = release.assets.some(
      (asset: Record<string, unknown> | null) =>
        asset?.name === name &&
        asset.state === "uploaded" &&
        typeof asset.size === "number" &&
        asset.size > 0,
    );
    if (!compatible || (best && compareVersions(version, best.version) <= 0)) continue;
    best = {
      version,
      // Never use an API-supplied URL to decide which page the app opens.
      pageUrl: `${MAC_RELEASES_PAGE}/tag/${encodeURIComponent(release.tag_name)}`,
      publishedAt: typeof release.published_at === "string" ? release.published_at : null,
    };
  }
  return best;
}

export interface MacUpdateCheckerOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  current?: string;
  form?: MacReleaseForm;
  arch?: string;
}

/** No download/install capability: the only action is opening a newer fork release's page. */
export function createMacUpdateChecker(o: MacUpdateCheckerOptions = {}) {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const current = o.current ?? APP_VERSION;
  const form = o.form ?? currentMacReleaseForm();
  const arch = o.arch ?? process.arch;
  let latest: MacRelease | null = null;
  let checkedAt: number | null = null;
  let error: string | null = null;
  let inflight: Promise<UpdateInfoDTO> | null = null;
  const answer = (): UpdateInfoDTO => ({
    current,
    latest: latest?.version ?? null,
    newer: latest !== null && compareVersions(latest.version, current) > 0,
    pageUrl: latest?.pageUrl ?? null,
    publishedAt: latest?.publishedAt ?? null,
    form,
    checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
    error,
  });
  async function refresh(): Promise<UpdateInfoDTO> {
    try {
      const response = await fetchImpl(MAC_RELEASES_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": APP_USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
      const releases: unknown = await response.json();
      if (!Array.isArray(releases)) throw new Error("GitHub returned an invalid release list");
      // An empty feed (or no compatible assets yet) is a successful check, not an error.
      latest = pickLatestMacRelease(releases, form, arch);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    checkedAt = now();
    return answer();
  }
  return {
    check(force = false): Promise<UpdateInfoDTO> {
      if (inflight) return inflight;
      if (!force && checkedAt !== null && now() - checkedAt < 60 * 60 * 1000)
        return Promise.resolve(answer());
      inflight = refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    updatePageUrl(): string | null {
      const info = answer();
      return info.newer ? info.pageUrl : null;
    },
  };
}
