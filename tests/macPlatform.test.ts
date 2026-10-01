import { describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { platformFeatures } from "../src/server/platformFeatures.js";
import { createHttpServer } from "../src/server/httpServer.js";

describe("macOS runtime", () => {
  it("excludes overlays only on macOS", () => {
    expect(platformFeatures("darwin").hud).toBe(false);
    expect(platformFeatures("win32").hud).toBe(true);
    expect(platformFeatures("linux").hud).toBe(true);
  });

  it("can shut down with a browser WebSocket still connected", async () => {
    const runtime = createHttpServer({
      port: 0,
      bindHost: "127.0.0.1",
      getSnapshot: () => ({}) as never,
      getStatus: () => ({}) as never,
      getCommanderPosition: () => null,
      getCommanderSystem: () => null,
    });
    await runtime.listening;
    const port = (runtime.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      await once(ws, "open");
      const closed = once(ws, "close");
      runtime.closeConnections();
      await closed;
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      ws.terminate();
      await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    }
  });
});
