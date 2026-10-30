import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/browser";
import { parseCsv } from "../src/csv";
import { extractDelayed, extractProducts } from "../src/extract";
import { startFixtureServer, type RequestRecord } from "../src/fixture-server";
import { RobotsDisallowedError } from "../src/robots";
import { makeTmp, removeTmp } from "./helpers";

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser.close();
});

const productRequests = (reqs: RequestRecord[]) => reqs.filter((r) => r.url.startsWith("/products"));

describe("extractProducts (paginated list)", () => {
  it("collects every product across all 5 pages and writes matching CSV and JSON", async () => {
    const server = await startFixtureServer();
    const out = await makeTmp();
    try {
      const r = await extractProducts({ browser, startUrl: `${server.url}/products`, outDir: out, delayMs: 0 });
      expect(r.pages).toBe(5);
      expect(r.rows).toHaveLength(23);
      expect(r.rows[0]).toEqual({ id: "P-001", name: "Harbor Mug", price: 12.5, category: "kitchen", stock: 40 });
      expect(r.rows[22]!.id).toBe("P-023");
      expect(new Set(r.rows.map((p) => p.id)).size).toBe(23); // no duplicates

      const json = JSON.parse(await readFile(path.join(out, "products.json"), "utf8")) as unknown[];
      expect(json).toHaveLength(23);
      const csv = parseCsv(await readFile(path.join(out, "products.csv"), "utf8"));
      expect(csv[0]).toEqual(["id", "name", "price", "category", "stock"]);
      expect(csv).toHaveLength(24);
      expect(csv[1]).toEqual(["P-001", "Harbor Mug", "12.5", "kitchen", "40"]);

      // It asked for each page exactly once and read robots.txt first.
      expect(productRequests(server.requests).map((x) => x.url)).toEqual([
        "/products",
        "/products?page=2",
        "/products?page=3",
        "/products?page=4",
        "/products?page=5",
      ]);
      expect(server.requests[0]!.url).toBe("/robots.txt");
    } finally {
      await server.close();
      await removeTmp(out);
    }
  });

  it("stops at maxPages", async () => {
    const server = await startFixtureServer();
    const out = await makeTmp();
    try {
      const r = await extractProducts({ browser, startUrl: `${server.url}/products`, outDir: out, delayMs: 0, maxPages: 2 });
      expect(r.pages).toBe(2);
      expect(r.rows).toHaveLength(10);
    } finally {
      await server.close();
      await removeTmp(out);
    }
  });

  it("keeps a polite gap of at least the configured delay between page requests", async () => {
    const server = await startFixtureServer();
    const out = await makeTmp();
    try {
      await extractProducts({ browser, startUrl: `${server.url}/products`, outDir: out, delayMs: 300 });
      const times = productRequests(server.requests).map((r) => r.at);
      expect(times).toHaveLength(5);
      for (let i = 1; i < times.length; i++) {
        // 300 ms configured; allow a little clock jitter between the server's timestamps.
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(270);
      }
    } finally {
      await server.close();
      await removeTmp(out);
    }
  });

  it("survives a flaky page: page 3 answers 503 once, the retry succeeds, nothing is duplicated", async () => {
    const server = await startFixtureServer({ flakyPages: { 3: 1 } });
    const out = await makeTmp();
    try {
      const seen: string[] = [];
      const r = await extractProducts({
        browser,
        startUrl: `${server.url}/products`,
        outDir: out,
        delayMs: 0,
        retries: 2,
        onRetry: (i) => seen.push(i.error),
      });
      expect(r.rows).toHaveLength(23);
      expect(r.retriesUsed).toBe(1);
      expect(seen[0]).toMatch(/HTTP 503/);
      expect(productRequests(server.requests).filter((x) => x.url === "/products?page=3")).toHaveLength(2);
    } finally {
      await server.close();
      await removeTmp(out);
    }
  });

  it("fails with a clear error when retries are switched off", async () => {
    const server = await startFixtureServer({ flakyPages: { 3: 1 } });
    const out = await makeTmp();
    try {
      await expect(
        extractProducts({ browser, startUrl: `${server.url}/products`, outDir: out, delayMs: 0, retries: 0 }),
      ).rejects.toThrow(/HTTP 503 for .*page=3/);
    } finally {
      await server.close();
      await removeTmp(out);
    }
  });

  it("does not retry an error that cannot get better (404): one request, one clear message", async () => {
    const server = await startFixtureServer();
    const out = await makeTmp();
    try {
      await expect(
        extractProducts({ browser, startUrl: `${server.url}/products?page=99`, outDir: out, delayMs: 0, retries: 3 }),
      ).rejects.toThrow(/HTTP 404/);
      expect(productRequests(server.requests)).toHaveLength(1);
    } finally {
      await server.close();
      await removeTmp(out);
    }
  });

  it("honours robots.txt: refuses a disallowed URL and never requests it", async () => {
    const server = await startFixtureServer();
    const out = await makeTmp();
    try {
      await expect(
        extractProducts({ browser, startUrl: `${server.url}/private/report`, outDir: out, delayMs: 0 }),
      ).rejects.toBeInstanceOf(RobotsDisallowedError);
      expect(server.requests.map((r) => r.url)).toEqual(["/robots.txt"]);
    } finally {
      await server.close();
      await removeTmp(out);
    }
  });
});

describe("extractDelayed (page that fills itself in late)", () => {
  it("a naive read right after load sees nothing, while the kit waits for the ready signal and gets all rows", async () => {
    const server = await startFixtureServer({ dataDelayMs: 700 });
    const out = await makeTmp();
    try {
      // Control: reading as soon as the page has loaded finds an empty list.
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${server.url}/delayed`, { waitUntil: "domcontentloaded" });
      expect(await page.locator("#data li").count()).toBe(0);
      await ctx.close();

      const started = Date.now();
      const r = await extractDelayed({ browser, url: `${server.url}/delayed`, outDir: out });
      expect(r.rows).toEqual([
        { id: "orders", label: "Orders", value: "128" },
        { id: "returns", label: "Returns", value: "7" },
        { id: "refunds", label: "Refunds", value: "3" },
      ]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(600); // it really did wait for the slow data
      const csv = parseCsv(await readFile(path.join(out, "delayed.csv"), "utf8"));
      expect(csv).toHaveLength(4);
    } finally {
      await server.close();
      await removeTmp(out);
    }
  });

  it("gives up with a clear timeout, not a hang, when the data takes longer than allowed", async () => {
    const server = await startFixtureServer({ dataDelayMs: 2500 });
    const out = await makeTmp();
    try {
      const started = Date.now();
      await expect(extractDelayed({ browser, url: `${server.url}/delayed`, outDir: out, timeoutMs: 400 })).rejects.toThrow(/Timeout 400ms exceeded/);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await server.close();
      await removeTmp(out);
    }
  });
});
