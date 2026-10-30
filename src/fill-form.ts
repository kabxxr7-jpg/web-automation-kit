import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { kitUserAgent, type CommonOptions } from "./browser";
import { readRecords } from "./csv";
import { sleep } from "./retry";
import { RobotsChecker } from "./robots";

export interface RowResult {
  /** 1-based position of the row in the CSV (header not counted). */
  row: number;
  /** The `id` column when there is one, else `row-N`. */
  key: string;
  status: "ok" | "error";
  message: string;
  at: string;
}

export interface FillFormOptions extends CommonOptions {
  formUrl: string;
  csvPath: string;
  /** JSON-lines results file. One line is appended per processed row, so a crash loses nothing. */
  logPath: string;
  /** On a re-run, also skip rows that failed last time. Default: failed rows are tried again. */
  skipFailed?: boolean;
  robots?: RobotsChecker;
  /**
   * TEST HOOK, not for real use: throw an InjectedFailure after this many rows have been processed in
   * this run, to simulate a crash and prove that a re-run resumes without repeating finished rows.
   */
  abortAfter?: number;
}

export interface FillFormSummary {
  total: number;
  skipped: number;
  attempted: number;
  ok: number;
  failed: number;
  logPath: string;
}

export class InjectedFailure extends Error {
  constructor(after: number) {
    super(`Injected failure after ${after} row(s) (test hook).`);
    this.name = "InjectedFailure";
  }
}

const truthy = (v: string | undefined): boolean => /^(1|y|yes|true|on|x)$/i.test((v ?? "").trim());
const firstLine = (e: unknown): string => ((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "").trim();

export async function readLog(logPath: string): Promise<RowResult[]> {
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RowResult);
}

export async function fillForm(opts: FillFormOptions): Promise<FillFormSummary> {
  const wait = opts.sleep ?? sleep;
  const delayMs = opts.delayMs ?? 500;
  const robots = opts.robots ?? new RobotsChecker();
  const records = readRecords(await readFile(opts.csvPath, "utf8"));

  // Refuse before touching the site if robots.txt disallows the form.
  await robots.assertAllowed(opts.formUrl);
  await mkdir(path.dirname(path.resolve(opts.logPath)), { recursive: true });

  const previous = await readLog(opts.logPath);
  const finished = new Set(previous.filter((r) => r.status === "ok" || (opts.skipFailed && r.status === "error")).map((r) => r.row));

  const context = await opts.browser.newContext({ userAgent: opts.userAgent ?? kitUserAgent() });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeoutMs ?? 5000);

  const summary: FillFormSummary = { total: records.length, skipped: 0, attempted: 0, ok: 0, failed: 0, logPath: opts.logPath };
  let processedThisRun = 0;

  try {
    for (let i = 0; i < records.length; i++) {
      const rowNo = i + 1;
      const rec = records[i]!;
      if (finished.has(rowNo)) {
        summary.skipped++;
        continue;
      }
      if (opts.abortAfter !== undefined && processedThisRun >= opts.abortAfter) throw new InjectedFailure(processedThisRun);

      const key = rec.id || `row-${rowNo}`;
      let result: RowResult;
      try {
        await page.goto(opts.formUrl, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("form#signup", { state: "visible" });
        await page.fill('input[name="name"]', rec.name ?? "");
        await page.fill('input[name="email"]', rec.email ?? "");
        // Throws, with Playwright's exact message, when the CSV asks for a plan the form does not offer.
        await page.selectOption('select[name="plan"]', rec.plan ?? "");
        await page.setChecked('input[name="newsletter"]', truthy(rec.newsletter));
        await page.click('button[type="submit"]');
        const outcome = page.locator('[data-testid="result"]');
        await outcome.waitFor({ state: "visible" });
        const status = await outcome.getAttribute("data-status");
        const text = (await outcome.innerText()).trim();
        result = { row: rowNo, key, status: status === "ok" ? "ok" : "error", message: text, at: new Date().toISOString() };
      } catch (e) {
        // One bad row never stops the batch: record the exact error and carry on.
        result = { row: rowNo, key, status: "error", message: firstLine(e), at: new Date().toISOString() };
      }

      await appendFile(opts.logPath, JSON.stringify(result) + "\n");
      summary.attempted++;
      processedThisRun++;
      if (result.status === "ok") summary.ok++;
      else summary.failed++;
      if (i < records.length - 1) await wait(delayMs);
    }
  } finally {
    await context.close();
  }
  return summary;
}
