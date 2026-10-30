import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { expect, test } from "@playwright/test";
import type { UpdateInfoDTO } from "../src/shared/types.js";

test("Mac release notifications stay manual and distinguish unpublished builds", async ({ page }) => {
  let info: UpdateInfoDTO = {
    current: "1.2.17",
    latest: null,
    newer: false,
    pageUrl: null,
    publishedAt: null,
    form: "macos-browser",
    checkedAt: new Date().toISOString(),
    error: null,
    download: { supported: false, state: "idle", version: null, received: 0, total: null, error: null },
  };
  let opened = 0;
  const downloads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/app/update/download")) downloads.push(request.url());
  });
  await page.route("**/api/app/update{,?*}", (route) => route.fulfill({ json: info }));
  await page.route("**/api/app/open-update", (route) => {
    expect(route.request().method()).toBe("POST");
    opened++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/app/whats-new{,?*}", (route) =>
    route.fulfill({
      json: {
        current: info.current,
        from: null,
        pending: false,
        error: null,
        releases: [
          {
            version: info.current,
            notes: "Changes in the installed upstream version.",
            publishedAt: null,
            pageUrl: "https://github.com/bahuckel/EDEXO-Compare/releases/tag/v1.2.17",
          },
        ],
      },
    }),
  );
  await page.goto("/launcher.html");
  await expect(page.locator("#main")).toHaveClass(/ready/);
  await page.locator("#wzDone").dispatchEvent("click");
  const status = page.locator("#versionText");
  const button = page.locator("#btnCheckUpdate");
  await expect(status).toContainText("no compatible Mac release published");

  info = { ...info, error: "offline" };
  await button.click();
  await expect(status).toContainText("could not check");
  await expect(status).toHaveAttribute("title", "offline");

  info = { ...info, latest: "1.2.16", error: null };
  await button.click();
  await expect(status).toContainText("local build; latest Mac release v1.2.16");
  info = { ...info, latest: info.current };
  await button.click();
  await expect(status).toHaveText("macOS v1.2.17 · latest Mac release");

  info = {
    ...info,
    latest: "1.2.20",
    newer: true,
    pageUrl: "https://github.com/sdangit/EDEXO-Compare/releases/tag/v1.2.20-macos",
  };
  await button.click();
  await expect(button).toHaveText("Download Mac v1.2.20");
  await button.click();
  await expect.poll(() => opened).toBe(1);
  expect(downloads).toEqual([]);
  await page.locator("#btnWhatsNew").click();
  await expect(page.locator("#whatsNewTitle")).toHaveText("Upstream changes in v1.2.17");
  await expect(page.locator("#whatsNewBody")).toContainText("Some features apply only to Windows or Linux");
  await expect(page.locator("#whatsNewBody")).toContainText("Changes in the installed upstream version");
});

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
  await expect(
    page.locator("#btnOverlayMenu, #overlayPickModal, #wzOpenHud, #wzHud, #btnKeybinds, #keybindsModal"),
  ).toHaveCount(0);
  const update = await (await request.get("/api/app/update")).json();
  expect(update.form).toBe("macos-browser");
  expect(update.download.supported).toBe(false);
  const diagnostics = await (await request.get("/api/app/diagnostics")).text();
  expect(diagnostics).toMatch(/Node 26\./);
  if (update.pageUrl)
    expect(update.pageUrl).toMatch(/^https:\/\/github\.com\/sdangit\/EDEXO-Compare\/releases\/tag\//);
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
