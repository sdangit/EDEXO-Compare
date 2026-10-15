import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as features from "../src/server/platformFeatures.js";
import { createHttpServer } from "../src/server/httpServer.js";

let runtime: ReturnType<typeof createHttpServer> | undefined;
afterEach(async () => {
  if (runtime) {
    runtime.closeConnections();
    await new Promise<void>((resolve) => runtime!.server.close(() => resolve()));
    runtime = undefined;
  }
  vi.restoreAllMocks();
});

async function start(platform: NodeJS.Platform) {
  const platformResult = features.platformFeatures(platform);
  vi.spyOn(features, "platformFeatures").mockReturnValue(platformResult);
  const setHudPrefs = vi.fn();
  runtime = createHttpServer({
    port: 0,
    bindHost: "127.0.0.1",
    getSnapshot: () => ({ bodies: [], journalSystems: [], marker: "full app" }) as never,
    getStatus: () => ({ ok: true }) as never,
    getCommanderPosition: () => null,
    getCommanderSystem: () => null,
    setHudPrefs,
  });
  await runtime.listening;
  const base = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  return { base, setHudPrefs, runtime };
}

describe("platform boundaries in the shared HTTP server", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "announces %s capabilities without caching",
    async (platform) => {
      const { base } = await start(platform);
      const response = await fetch(`${base}/api/platform.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toContain("javascript");
      expect(await response.text()).toBe(
        `window.edexoPlatform = ${JSON.stringify({ platform, hud: platform !== "darwin" })};`,
      );
      expect((await fetch(`${base}/api/status`)).status).toBe(200);
      const snapshot = await (await fetch(`${base}/api/state`)).json();
      expect(snapshot.marker).toBe("full app");
    },
  );

  it("blocks all HUD entry points and preference writes on macOS", async () => {
    const { base, setHudPrefs } = await start("darwin");
    for (const route of [
      "/api/hud",
      "/api/hud/overlay",
      "/api/elite-display-mode",
      "/hud",
      "/hud.css",
      "/hud.webmanifest",
      "/hud/main.js",
      "/distance-overlay.html",
      "/api/state?channel=hud",
    ]) {
      const response = await fetch(base + route);
      expect(response.status, route).toBe(404);
      expect(await response.text(), route).toContain("HUD overlays are not included on macOS");
    }
    const response = await fetch(`${base}/api/settings/hud-prefs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scale: 2 }),
    });
    expect(response.status).toBe(404);
    expect(setHudPrefs).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"] as const)("retains HUD state and preference writes on %s", async (platform) => {
    const { base, setHudPrefs } = await start(platform);
    expect((await fetch(`${base}/api/state?channel=hud`)).status).toBe(200);
    expect(
      (
        await fetch(`${base}/api/settings/hud-prefs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scale: 2 }),
        })
      ).status,
    ).toBe(200);
    expect(setHudPrefs).toHaveBeenCalledWith({ scale: 2 });
  });

  it.each(["darwin", "win32", "linux"] as const)(
    "handles HUD channel negotiation on %s",
    async (platform) => {
      const { base } = await start(platform);
      const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
      try {
        const initial = once(ws, "message");
        await once(ws, "open");
        await initial;
        if (platform === "darwin") {
          const closed = once(ws, "close");
          ws.send(JSON.stringify({ type: "hello", channel: "hud" }));
          const [code, reason] = await closed;
          expect(code).toBe(1008);
          expect(String(reason)).toContain("HUD overlays are not included on macOS");
        } else {
          const message = once(ws, "message");
          ws.send(JSON.stringify({ type: "hello", channel: "hud" }));
          await message;
          expect(ws.readyState).toBe(WebSocket.OPEN);
        }
      } finally {
        ws.terminate();
      }
    },
  );

  it.each(["darwin", "win32", "linux"] as const)(
    "handles HUD channel selection in the WebSocket URL on %s",
    async (platform) => {
      const { base } = await start(platform);
      const ws = new WebSocket(base.replace("http:", "ws:") + "/ws?channel=hud");
      const messages: string[] = [];
      ws.on("message", (raw) => messages.push(String(raw)));
      try {
        if (platform === "darwin") {
          const [code, reason] = await once(ws, "close");
          expect(code).toBe(1008);
          expect(String(reason)).toContain("HUD overlays are not included on macOS");
          expect(messages).toEqual([]);
        } else {
          const [raw] = await once(ws, "message");
          expect(JSON.parse(String(raw)).type).toBe("state");
          expect(ws.readyState).toBe(WebSocket.OPEN);
        }
      } finally {
        ws.terminate();
      }
    },
  );

  it("keeps UI commands working alongside macOS connection cleanup", async () => {
    const { base, runtime } = await start("darwin");
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
    try {
      const initial = once(ws, "message");
      await once(ws, "open");
      await initial;
      const message = once(ws, "message");
      runtime.broadcastUiCommand({ cmd: "bodyTab", dir: 1 });
      expect(JSON.parse(String((await message)[0]))).toEqual({
        type: "uiCommand",
        payload: { cmd: "bodyTab", dir: 1 },
      });
      const closed = once(ws, "close");
      runtime.closeConnections();
      await closed;
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      ws.terminate();
    }
  });
});
