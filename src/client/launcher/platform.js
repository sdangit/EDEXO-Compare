// Server capabilities are loaded before the launcher modules in browser and Electron builds.
export const isMac = window.edexoPlatform?.platform === "darwin";
export const hudEnabled = window.edexoPlatform?.hud ?? false;

if (!hudEnabled) {
  for (const id of ["btnOverlayMenu", "overlayPickModal", "btnKeybinds", "keybindsModal", "wzOpenHud", "journalHealth", "trayPrefRow"]) {
    document.getElementById(id)?.remove();
  }
  document.getElementById("wzHud")?.closest("li")?.remove();
  const intro = document.querySelector("#wizardModal h3 + p");
  if (intro) intro.textContent = "Choose your journal folder and open the app. Start Elite Dangerous before this app.";
}
