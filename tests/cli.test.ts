import { execFile } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv";
import { startFixtureServer, type FixtureServer } from "../src/fixture-server";
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
  server = await startFixtureServer();
});
afterAll(async () => {
  await server.close();
});

describe("command line", () => {
  it("extract writes the files and exits 0", async () => {
    const out = await makeTmp();
    try {
      const r = await kit(["extract", `${server.url}/products`, "--out", out, "--delay-ms", "0"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ rows: 23, pages: 5, retriesUsed: 0 });
      expect(parseCsv(await readFile(path.join(out, "products.csv"), "utf8"))).toHaveLength(24);
    } finally {
      await removeTmp(out);
    }
  });

  it("fill-form exits 1 when some rows failed and still writes the full log", async () => {
    const dir = await makeTmp();
    try {
      const csv = path.join(dir, "rows.csv");
      await copyFile(path.join(ROOT, "examples/rows.csv"), csv);
      const log = path.join(dir, "log.jsonl");
      const r = await kit(["fill-form", `${server.url}/form`, "--csv", csv, "--log", log, "--delay-ms", "0", "--timeout-ms", "1000"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ total: 6, ok: 3, failed: 3 });
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(6);
    } finally {
      await removeTmp(dir);
    }
  });

  it("exits 2 with the robots.txt rule when asked for a disallowed URL", async () => {
    const out = await makeTmp();
    try {
      const r = await kit(["snapshot", `${server.url}/private/report`, "--out", out]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("robots.txt disallows");
      expect(r.stderr).toContain("Disallow: /private/");
    } finally {
      await removeTmp(out);
    }
  });

  it("exits 2 with usage for an unknown command or a missing URL", async () => {
    const a = await kit(["frobnicate", "http://127.0.0.1:1/"]);
    expect(a.code).toBe(2);
    expect(a.stderr).toContain("Unknown command");
    const b = await kit(["extract"]);
    expect(b.code).toBe(2);
    expect(b.stderr).toContain("Missing URL");
  });
});
