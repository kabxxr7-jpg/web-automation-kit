import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/browser";
import { fillForm, InjectedFailure, readLog } from "../src/fill-form";
import { startFixtureServer } from "../src/fixture-server";
import { RobotsChecker, RobotsDisallowedError } from "../src/robots";
import { fakeFetch, makeTmp, removeTmp } from "./helpers";

const ROWS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples/rows.csv");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser.close();
});

async function setup() {
  const server = await startFixtureServer();
  const dir = await makeTmp();
  const csvPath = path.join(dir, "rows.csv");
  await copyFile(ROWS, csvPath);
  return { server, dir, csvPath, logPath: path.join(dir, "results.jsonl") };
}

describe("fillForm", () => {
  it("submits good rows, records the exact error for bad rows, and never stops the batch", async () => {
    const { server, dir, csvPath, logPath } = await setup();
    try {
      const s = await fillForm({ browser, formUrl: `${server.url}/form`, csvPath, logPath, delayMs: 0, timeoutMs: 1500 });
      expect(s).toMatchObject({ total: 6, skipped: 0, attempted: 6, ok: 3, failed: 3 });

      const log = await readLog(logPath);
      expect(log.map((r) => [r.key, r.status])).toEqual([
        ["r1", "ok"],
        ["r2", "ok"],
        ["r3", "error"],
        ["r4", "error"],
        ["r5", "ok"],
        ["r6", "error"],
      ]);
      expect(log[0]!.message).toBe("Saved submission #1 for Ada Example");
      // A server-side validation error is captured word for word.
      expect(log[2]!.message).toBe("Error: Email address is not valid");
      expect(log[5]!.message).toBe("Error: Plan must be basic, pro or team");
      // A plan the form does not offer fails inside the browser step, with Playwright's own message.
      expect(log[3]!.message).toMatch(/selectOption: Timeout 1500ms exceeded/);

      // The site really received exactly the three good rows, with the checkbox honoured.
      expect(server.submissions.map((x) => [x.name, x.plan, x.newsletter])).toEqual([
        ["Ada Example", "pro", true],
        ["Grace Sample", "basic", false],
        ["Alan Demo", "team", true],
      ]);
    } finally {
      await server.close();
      await removeTmp(dir);
    }
  });

  it("resumes after a crash without submitting any finished row twice", async () => {
    const { server, dir, csvPath, logPath } = await setup();
    try {
      const common = { browser, formUrl: `${server.url}/form`, csvPath, logPath, delayMs: 0, timeoutMs: 1500 };

      // Run 1 "crashes" after two rows.
      await expect(fillForm({ ...common, abortAfter: 2 })).rejects.toBeInstanceOf(InjectedFailure);
      expect((await readLog(logPath)).map((r) => r.key)).toEqual(["r1", "r2"]);
      expect(server.submissions).toHaveLength(2);

      // Run 2 picks up at row 3.
      const s = await fillForm(common);
      expect(s).toMatchObject({ total: 6, skipped: 2, attempted: 4, ok: 1, failed: 3 });

      const log = await readLog(logPath);
      expect(log.map((r) => r.key)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]); // each row logged once
      const names = server.submissions.map((x) => x.name);
      expect(names).toEqual(["Ada Example", "Grace Sample", "Alan Demo"]);
      expect(new Set(names).size).toBe(names.length); // no duplicates on the site
    } finally {
      await server.close();
      await removeTmp(dir);
    }
  });

  it("on a complete re-run, finished rows are skipped and failed rows are tried again (or skipped with skipFailed)", async () => {
    const { server, dir, csvPath, logPath } = await setup();
    try {
      const common = { browser, formUrl: `${server.url}/form`, csvPath, logPath, delayMs: 0, timeoutMs: 1000 };
      await fillForm(common);

      const again = await fillForm(common);
      expect(again).toMatchObject({ skipped: 3, attempted: 3, ok: 0, failed: 3 });
      expect(server.submissions).toHaveLength(3); // the three good rows were not sent again

      const skip = await fillForm({ ...common, skipFailed: true });
      expect(skip).toMatchObject({ skipped: 6, attempted: 0 });
    } finally {
      await server.close();
      await removeTmp(dir);
    }
  });

  it("honours robots.txt: refuses before opening the form or submitting anything", async () => {
    const { server, dir, csvPath, logPath } = await setup();
    try {
      const robots = new RobotsChecker({ fetchImpl: fakeFetch("User-agent: *\nDisallow: /form\n") });
      await expect(fillForm({ browser, formUrl: `${server.url}/form`, csvPath, logPath, delayMs: 0, robots })).rejects.toBeInstanceOf(
        RobotsDisallowedError,
      );
      expect(server.requests).toHaveLength(0);
      expect(await readLog(logPath)).toEqual([]);
    } finally {
      await server.close();
      await removeTmp(dir);
    }
  });
});
