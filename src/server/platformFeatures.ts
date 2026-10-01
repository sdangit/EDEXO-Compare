/** Desktop overlays are deliberately excluded from the macOS/CrossOver port. */
export function platformFeatures(platform = process.platform) {
  return { platform, hud: platform !== "darwin" };
}
