import { mkdir } from "node:fs/promises";
import path from "node:path";
import { kitUserAgent, type CommonOptions } from "./browser";
import { RobotsChecker } from "./robots";

export interface SnapshotOptions extends CommonOptions {
  url: string;
  outDir: string;
  robots?: RobotsChecker;
}

export interface SnapshotResult {
  pngPath: string;
  pdfPath: string;
  title: string;
}

function slug(url: string): string {
  const u = new URL(url);
  const raw = `${u.hostname}${u.pathname}${u.search}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (raw || "page").slice(0, 80);
}

/** Full-page screenshot plus a PDF of one URL. Waits for the network to go quiet, not for a fixed time. */
export async function snapshot(opts: SnapshotOptions): Promise<SnapshotResult> {
  const robots = opts.robots ?? new RobotsChecker();
  await robots.assertAllowed(opts.url);
  await mkdir(opts.outDir, { recursive: true });

  const context = await opts.browser.newContext({ userAgent: opts.userAgent ?? kitUserAgent(), viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeoutMs ?? 15_000);
  try {
    const res = await page.goto(opts.url, { waitUntil: "networkidle" });
    if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status() ?? "none"} for ${opts.url}`);
    const base = path.join(opts.outDir, slug(opts.url));
    const pngPath = `${base}.png`;
    const pdfPath = `${base}.pdf`;
    await page.screenshot({ path: pngPath, fullPage: true });
    await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
    return { pngPath, pdfPath, title: await page.title() };
  } finally {
    await context.close();
  }
}
