import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv";
import { closedPort, startFixtureServer, type FixtureServer } from "../src/fixture-server";
import { makeTmp, removeTmp } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function kit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: ROOT, timeout: 50_000 }, (err, stdout, stderr) => {
      const raw = err ? (err as { code?: unknown }).code : 0;
      resolve({ code: typeof raw === "number" ? raw : 1, stdout, stderr });
    });
  });
}

let server: FixtureServer;
beforeAll(async () => {
  server = await startFixtureServer({ externalLinks: [`http://127.0.0.1:${await closedPort()}/gone`] });
});
afterAll(async () => {
  await server.close();
});

describe("site checks on the command line", () => {
  it("check-links exits 1 when an internal link is broken and writes both reports", async () => {
    const out = await makeTmp();
    try {
      const r = await kit(["check-links", `${server.url}/site/`, "--out", out, "--delay-ms", "0", "--timeout-ms", "500"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ brokenInternal: 3, brokenExternal: 1, redirectChains: 1, skippedRobots: 1, truncated: false });
      expect(await readFile(path.join(out, "link-report.md"), "utf8")).toContain("/site/team");
      const rows = parseCsv(await readFile(path.join(out, "link-report.csv"), "utf8"));
      expect(rows.some((row) => row[3]?.endsWith("/site/team") && row[1] === "broken")).toBe(true);
    } finally {
      await removeTmp(out);
    }
  });

  it("check-links exits 0 when only an external link is broken", async () => {
    const out = await makeTmp();
    try {
      const r = await kit(["check-links", `${server.url}/site/clean/`, "--out", out, "--delay-ms", "0", "--timeout-ms", "500"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ brokenInternal: 0, brokenExternal: 1 });
    } finally {
      await removeTmp(out);
    }
  });

  it("test-form exits 0 on success and 1 when the form did not work", async () => {
    const fields = "name=Ada Example,email=ada@example.com,message=Hello there";
    const ok = await kit(["test-form", `${server.url}/site/contact`, "--fields", fields, "--expect-text", "Thank you"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ status: "ok" });
    const silent = await kit(["test-form", `${server.url}/site/contact-silent`, "--fields", fields, "--expect-text", "Thank you"]);
    expect(silent.code).toBe(1);
    expect(JSON.parse(silent.stdout)).toMatchObject({ status: "silent-failure" });
  });

  it("test-form exits 2 on a non-local site without --i-own-this-site and sends nothing", async () => {
    const r = await kit(["test-form", "http://example.com/contact", "--fields", "name=A"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--i-own-this-site");
    expect(r.stdout).toBe("");
  });
});
