import { parseArgs } from "node:util";
import { launchBrowser } from "./browser";
import { extractDelayed, extractProducts } from "./extract";
import { fillForm } from "./fill-form";
import { startFixtureServer } from "./fixture-server";
import { RobotsDisallowedError, RobotsUnavailableError } from "./robots";
import { snapshot } from "./snapshot";

const USAGE = `web-automation-kit

Usage:
  kit serve [--port 8788]                         start the local fixture site and print its URL
  kit extract <url> --out <dir> [--mode list|delayed] [--delay-ms 500] [--retries 2] [--timeout-ms 10000] [--max-pages 50]
  kit fill-form <form-url> --csv <rows.csv> --log <results.jsonl> [--delay-ms 500] [--skip-failed] [--timeout-ms 5000]
  kit snapshot <url> --out <dir> [--timeout-ms 15000]

Common: --headed (show the browser). robots.txt is always respected; there is no switch to turn that off.
Exit codes: 0 all good, 1 some rows failed, 2 refused (robots.txt) or bad usage, 3 unexpected error.
`;

const num = (v: string | undefined, d: number): number => {
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Expected a non-negative number, got "${v}"`);
  return n;
};

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      csv: { type: "string" },
      log: { type: "string" },
      mode: { type: "string" },
      port: { type: "string" },
      "delay-ms": { type: "string" },
      retries: { type: "string" },
      "timeout-ms": { type: "string" },
      "max-pages": { type: "string" },
      "skip-failed": { type: "boolean" },
      headed: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  if (command === "serve") {
    const server = await startFixtureServer({ port: num(values.port, 8788) });
    console.log(`Fixture site running at ${server.url}  (Ctrl+C to stop)`);
    await new Promise<void>(() => {});
    return 0;
  }

  if (!target) {
    console.error(`Missing URL.\n\n${USAGE}`);
    return 2;
  }

  const browser = await launchBrowser({ headless: !values.headed });
  try {
    const common = { browser, delayMs: num(values["delay-ms"], 500), timeoutMs: values["timeout-ms"] ? num(values["timeout-ms"], 0) : undefined };

    if (command === "extract") {
      if (!values.out) throw new Error("--out <dir> is required");
      if (values.mode === "delayed") {
        const r = await extractDelayed({ ...common, url: target, outDir: values.out });
        console.log(JSON.stringify({ rows: r.rows.length, json: r.jsonPath, csv: r.csvPath }, null, 2));
      } else {
        const r = await extractProducts({
          ...common,
          startUrl: target,
          outDir: values.out,
          retries: num(values.retries, 2),
          maxPages: num(values["max-pages"], 50),
          onRetry: (i) => console.error(`retry ${i.attempt} for ${i.url} in ${i.delayMs} ms: ${i.error}`),
        });
        console.log(JSON.stringify({ rows: r.rows.length, pages: r.pages, retriesUsed: r.retriesUsed, json: r.jsonPath, csv: r.csvPath }, null, 2));
      }
      return 0;
    }

    if (command === "fill-form") {
      if (!values.csv || !values.log) throw new Error("--csv <rows.csv> and --log <results.jsonl> are required");
      const s = await fillForm({ ...common, formUrl: target, csvPath: values.csv, logPath: values.log, skipFailed: values["skip-failed"] });
      console.log(JSON.stringify(s, null, 2));
      return s.failed > 0 ? 1 : 0;
    }

    if (command === "snapshot") {
      if (!values.out) throw new Error("--out <dir> is required");
      const r = await snapshot({ ...common, url: target, outDir: values.out });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }

    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  } finally {
    await browser.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof RobotsDisallowedError || e instanceof RobotsUnavailableError) {
      console.error(e.message);
      process.exit(2);
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(3);
  },
);
