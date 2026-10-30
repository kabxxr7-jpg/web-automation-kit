import { readFile, stat } from "node:fs/promises";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/browser";
import { startFixtureServer, type FixtureServer } from "../src/fixture-server";
import { RobotsDisallowedError } from "../src/robots";
import { snapshot } from "../src/snapshot";
import { makeTmp, removeTmp } from "./helpers";

let browser: Browser;
let server: FixtureServer;
beforeAll(async () => {
  browser = await launchBrowser();
  server = await startFixtureServer({ dataDelayMs: 500 });
});
afterAll(async () => {
  await browser.close();
  await server.close();
});

describe("snapshot", () => {
  it("writes a real PNG and a real PDF of the page and returns its title", async () => {
    const out = await makeTmp();
    try {
      const r = await snapshot({ browser, url: `${server.url}/products`, outDir: out });
      expect(r.title).toBe("Products, page 1");
      const png = await readFile(r.pngPath);
      const pdf = await readFile(r.pdfPath);
      expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG signature
      expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
      expect((await stat(r.pngPath)).size).toBeGreaterThan(1000);
      expect((await stat(r.pdfPath)).size).toBeGreaterThan(1000);
    } finally {
      await removeTmp(out);
    }
  });

  it("waits for a late-loading page to settle before capturing it", async () => {
    const out = await makeTmp();
    try {
      const started = Date.now();
      const r = await snapshot({ browser, url: `${server.url}/delayed`, outDir: out });
      expect(Date.now() - started).toBeGreaterThanOrEqual(450); // it waited for the slow request, not a fixed pause
      expect(r.title).toContain("Weekly report");
    } finally {
      await removeTmp(out);
    }
  });

  it("honours robots.txt: refuses a disallowed URL and never requests it", async () => {
    const out = await makeTmp();
    try {
      const before = server.requests.length;
      await expect(snapshot({ browser, url: `${server.url}/private/report`, outDir: out })).rejects.toBeInstanceOf(RobotsDisallowedError);
      expect(server.requests.slice(before).some((r) => r.url === "/private/report")).toBe(false);
    } finally {
      await removeTmp(out);
    }
  });

  it("reports a missing page as a clear error instead of saving a blank screenshot", async () => {
    const out = await makeTmp();
    try {
      await expect(snapshot({ browser, url: `${server.url}/no-such-page`, outDir: out })).rejects.toThrow(/HTTP 404/);
    } finally {
      await removeTmp(out);
    }
  });
});
