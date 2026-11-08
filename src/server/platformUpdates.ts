import { createUpdateChecker, currentReleaseForm } from "./updateCheck.js";
import { createMacUpdateChecker } from "./macUpdateCheck.js";
import { createAppUpdater } from "./appUpdater.js";
import { createWhatsNew } from "./whatsNew.js";

/** Select the platform's update source while retaining upstream release notes. */
export function createPlatformUpdates() {
  // Keep upstream notes for the installed base version; only fork releases offer Mac updates.
  const upstreamUpdates = createUpdateChecker();
  const updateChecker = process.platform === "darwin" ? createMacUpdateChecker() : upstreamUpdates;
  const appUpdater = createAppUpdater({
    newerAsset: () => (process.platform === "darwin" ? null : upstreamUpdates.newerAsset()),
    form: currentReleaseForm(),
    ...(process.platform === "darwin" ? { supported: false } : {}),
  });
  const whatsNew = createWhatsNew({
    check: () => upstreamUpdates.check(false),
    notesBetween: (from, to) => upstreamUpdates.notesBetween(from, to),
    lastError: () => upstreamUpdates.lastError(),
  });
  return { updateChecker, appUpdater, whatsNew };
}
