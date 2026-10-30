import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { kitUserAgent, type CommonOptions } from "./browser";
import { toCsv } from "./csv";
import { NonRetryableError, retry, sleep } from "./retry";
import { RobotsChecker } from "./robots";

export interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  stock: number;
}

export interface ExtractOptions extends CommonOptions {
  /** First page of the paginated list. */
  startUrl: string;
  outDir: string;
  /** Retries per page after the first attempt, for flaky loads (5xx, 429, timeouts). */
  retries?: number;
  /** Safety stop so a bad "next" link can never loop forever. */
  maxPages?: number;
  robots?: RobotsChecker;
  onRetry?: (info: { url: string; attempt: number; delayMs: number; error: string }) => void;
}

export interface ExtractResult {
  rows: Product[];
  pages: number;
  retriesUsed: number;
  csvPath: string;
  jsonPath: string;
}

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";

/** Loads one URL and waits for a CONDITION (an element on screen), not for a fixed amount of time. */
async function loadWhenReady(page: Page, url: string, readySelector: string, retries: number, wait: (ms: number) => Promise<void>, onRetry?: ExtractOptions["onRetry"]): Promise<number> {
  let used = 0;
  await retry(
    async () => {
      const res = await page.goto(url, { waitUntil: "domcontentloaded" });
      if (!res) throw new Error(`No response for ${url}`);
      const status = res.status();
      if (status >= 500 || status === 429) throw new Error(`HTTP ${status} for ${url}`);
      if (status >= 400) throw new NonRetryableError(`HTTP ${status} for ${url}`);
      await page.waitForSelector(readySelector, { state: "visible" });
    },
    {
      retries,
      baseDelayMs: 200,
      sleep: wait,
      onRetry: (error, attempt, delayMs) => {
        used++;
        onRetry?.({ url, attempt, delayMs, error: firstLine(error) });
      },
    },
  );
  return used;
}

export async function extractProducts(opts: ExtractOptions): Promise<ExtractResult> {
  const retries = opts.retries ?? 2;
  const delayMs = opts.delayMs ?? 500;
  const maxPages = opts.maxPages ?? 50;
  const wait = opts.sleep ?? sleep;
  const robots = opts.robots ?? new RobotsChecker();

  await mkdir(opts.outDir, { recursive: true });
  const context = await opts.browser.newContext({ userAgent: opts.userAgent ?? kitUserAgent() });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeoutMs ?? 10_000);

  const rows: Product[] = [];
  const seen = new Set<string>();
  let url: string | null = opts.startUrl;
  let pages = 0;
  let retriesUsed = 0;

  try {
    while (url && pages < maxPages && !seen.has(url)) {
      seen.add(url);
      await robots.assertAllowed(url);
      retriesUsed += await loadWhenReady(page, url, '[data-testid="product-list"]', retries, wait, opts.onRetry);
      pages++;

      const found = await page.$$eval('[data-testid="product-list"] li.product', (els) =>
        els.map((el) => ({
          id: el.getAttribute("data-id") ?? "",
          name: el.querySelector(".name")?.textContent?.trim() ?? "",
          price: Number(el.querySelector(".price")?.textContent ?? "NaN"),
          category: el.querySelector(".category")?.textContent?.trim() ?? "",
          stock: Number(el.querySelector(".stock")?.textContent ?? "NaN"),
        })),
      );
      rows.push(...found);

      // The list is already on screen, so counting the "next" links is exact: no waiting, no guessing.
      const nextLink = page.locator('a[rel="next"]');
      const href = (await nextLink.count()) > 0 ? await nextLink.first().getAttribute("href") : null;
      url = href ? new URL(href, page.url()).toString() : null;
      // Polite pause between page requests. It is a configured delay, not a guess about load time.
      if (url) await wait(delayMs);
    }
  } finally {
    await context.close();
  }

  const jsonPath = path.join(opts.outDir, "products.json");
  const csvPath = path.join(opts.outDir, "products.csv");
  await writeFile(jsonPath, JSON.stringify(rows, null, 2) + "\n");
  await writeFile(csvPath, toCsv(["id", "name", "price", "category", "stock"], rows as unknown as Record<string, unknown>[]));
  return { rows, pages, retriesUsed, csvPath, jsonPath };
}

export interface DelayedRow {
  id: string;
  label: string;
  value: string;
}

export interface ExtractDelayedOptions extends CommonOptions {
  url: string;
  outDir: string;
  robots?: RobotsChecker;
}

/** A page that fills itself in after a slow request: wait until the page SAYS it is ready, then read. */
export async function extractDelayed(opts: ExtractDelayedOptions): Promise<{ rows: DelayedRow[]; jsonPath: string; csvPath: string }> {
  const robots = opts.robots ?? new RobotsChecker();
  await mkdir(opts.outDir, { recursive: true });
  await robots.assertAllowed(opts.url);
  const context = await opts.browser.newContext({ userAgent: opts.userAgent ?? kitUserAgent() });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeoutMs ?? 10_000);
  try {
    const res = await page.goto(opts.url, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status() ?? "none"} for ${opts.url}`);
    await page.waitForSelector('#data[data-ready="true"]', { state: "attached" });
    const rows = await page.$$eval("#data li", (els) =>
      els.map((el) => {
        const text = el.textContent ?? "";
        const i = text.indexOf(": ");
        return { id: el.getAttribute("data-id") ?? "", label: i < 0 ? text : text.slice(0, i), value: i < 0 ? "" : text.slice(i + 2) };
      }),
    );
    const jsonPath = path.join(opts.outDir, "delayed.json");
    const csvPath = path.join(opts.outDir, "delayed.csv");
    await writeFile(jsonPath, JSON.stringify(rows, null, 2) + "\n");
    await writeFile(csvPath, toCsv(["id", "label", "value"], rows as unknown as Record<string, unknown>[]));
    return { rows, jsonPath, csvPath };
  } finally {
    await context.close();
  }
}
