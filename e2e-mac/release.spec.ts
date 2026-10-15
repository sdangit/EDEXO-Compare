import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { expect, test } from "@playwright/test";

test("extracted Mac release serves predictions and its launcher without HUDs", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const hudRequests: string[] = [];
  page.on("request", (req) => {
    if (/\/api\/(hud|elite-display-mode)|\/api\/settings\/hud-prefs/.test(req.url()))
      hudRequests.push(req.url());
  });
  await page.goto("/");
  await expect(page.locator(".body-pane")).toBeVisible();
  await expect(page.getByText("Smoke Test", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".species-card, .srow").first()).toBeVisible();
  await page.screenshot({ path: "build-artifacts/macos-app.png", fullPage: true });
  await page.goto("/launcher.html");
  await expect(page.locator("#main")).toHaveClass(/ready/);
  await expect(page.locator("#btnOverlayMenu, #overlayPickModal, #wzOpenHud, #wzHud, #btnKeybinds, #keybindsModal")).toHaveCount(0);
  await page.locator("#wzDone").dispatchEvent("click");
  await page.locator("#btnOptions").dispatchEvent("click");
  await expect(page.locator("#journalInput")).toHaveValue(info.config.metadata.journalDir);
  await page.locator("#modalCancel").dispatchEvent("click");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "build-artifacts/macos-launcher.png", fullPage: true });
  await page.waitForTimeout(3000); // include the old delayed HUD-preference sync
  expect(hudRequests).toEqual([]);
  expect(errors).toEqual([]);
  for (const route of [
    "/api/hud/overlay",
    "/api/elite-display-mode",
    "/hud-overlay.html",
    "/hud/main.js",
    "/api/state?channel=hud",
  ]) {
    expect((await request.get(route)).status(), route).toBe(404);
  }
  const releaseDir = info.config.metadata.releaseDir as string;
  expect(
    readdirSync(path.join(releaseDir, "web")).some(
      (name) => name.endsWith("-overlay.html") || name === "hud",
    ),
  ).toBe(false);
  expect(existsSync(path.join(releaseDir, "sql-wasm/sql-wasm.wasm"))).toBe(true);
});

test("live journal writes update the running packaged server", async ({ request }, info) => {
  const journalDir = info.config.metadata.journalDir as string;
  const journal = readdirSync(journalDir).find((name) => name.startsWith("Journal."))!;
  appendFileSync(
    path.join(journalDir, journal),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "FSDJump",
      StarSystem: "Mac Live Test",
      SystemAddress: 123456789013,
      StarPos: [1201, 60, 4100],
      JumpDist: 1,
      FuelUsed: 0.1,
      FuelLevel: 31.9,
      SystemAllegiance: "",
      SystemEconomy: "$economy_None;",
      SystemGovernment: "$government_None;",
      SystemSecurity: "$GAlAXY_MAP_INFO_state_anarchy;",
      Population: 0,
    })}\n`,
  );
  await expect
    .poll(async () => (await (await request.get("/api/status")).json()).live?.systemName, { timeout: 20_000 })
    .toBe("Mac Live Test");
});

test("Status.json telemetry still reaches the app channel without HUDs", async ({ request }, info) => {
  const ws = new WebSocket("ws://127.0.0.1:7129/ws");
  const fuels: number[] = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === "state" && frame.payload.liveShipFuelRange?.hasLiveStatusFuel)
      fuels.push(frame.payload.liveShipFuelRange.fuelMainT);
  });
  try {
    await once(ws, "open");
    for (const fuelMain of [17.25, 16.5]) {
      writeFileSync(
        path.join(info.config.metadata.journalDir as string, "Status.json"),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "Status",
          Flags: 0,
          Fuel: { FuelMain: fuelMain, FuelReservoir: 0.5 },
        }),
      );
      await expect.poll(() => fuels.includes(fuelMain), { timeout: 20_000 }).toBe(true);
      const snapshot = await (await request.get("/api/state")).json();
      expect(snapshot.liveShipFuelRange).toMatchObject({
        hasLiveStatusFuel: true,
        fuelMainT: fuelMain,
        fuelReserveT: 0.5,
        fuelTotalT: fuelMain + 0.5,
      });
    }
  } finally {
    ws.terminate();
  }
});
