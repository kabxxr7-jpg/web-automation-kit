# web-automation-kit

A small, tested starting point for "automate this repetitive task in a browser" jobs: pull a paginated list into CSV and JSON, fill a web form from a spreadsheet row by row, and save a full-page screenshot and PDF of a page. It drives the Google Chrome already installed on the machine through Playwright.

**Status:** a proof project (34 tests, run locally, against a small fictional site that this repo serves on localhost). Not used in production or by any client. See "Limits" for what was not verified.

## What is in it

| Command | What it does |
|---|---|
| `extract <url>` | Walks a paginated product list through its "next" links, waits for the list to appear on each page, retries flaky loads, pauses politely between pages, and writes `products.csv` and `products.json`. `--mode delayed` reads a page that fills itself in late. |
| `fill-form <url>` | Reads rows from a CSV, submits the form once per row, and appends one line per row to a results log (`ok`, or the exact error). A crash or a re-run picks up where it stopped. |
| `snapshot <url>` | Saves a full-page PNG and an A4 PDF of one URL. |
| `serve` | Starts the fictional fixture site so you can try the other commands. |

## Try it (two terminals)

```bash
npm install
npm run kit -- serve                      # terminal 1: prints http://127.0.0.1:8788
```

```bash
npm run kit -- extract http://127.0.0.1:8788/products --out out/products
npm run kit -- fill-form http://127.0.0.1:8788/form --csv examples/rows.csv --log out/results.jsonl
npm run kit -- snapshot http://127.0.0.1:8788/products --out out/snap
```

Needs Google Chrome installed (no browser download) and a recent Node; it was developed and tested on Node 25 only, other versions are untested. Options: `--delay-ms` (pause between page requests, default 500), `--retries` (per page, default 2), `--timeout-ms` (per waiting step), `--max-pages`, `--skip-failed`, `--headed`. Exit codes: 0 all good, 1 some rows failed, 2 refused by robots.txt or bad usage, 3 unexpected error.

## How it avoids the usual traps

- **No fixed sleeps for loading.** Pages are read after a condition is true (the product list is visible, the delayed list says `data-ready="true"`, the result message appeared). The only pauses are the polite delay you configure and the backoff between retries.
- **Clear timeouts.** Every waiting step has a timeout and fails with Playwright's own message instead of hanging.
- **One bad row never stops a batch.** The exact error is logged and the next row runs.
- **Resumable.** The results log is appended after every row. Re-running skips rows that already succeeded; rows that failed are tried again unless `--skip-failed` is set.
- **Honest about itself.** It sends a `web-automation-kit/0.1` User-Agent. It does not disguise itself as a person's browser.
- **Respects robots.txt.** Before any page is requested the kit reads the site's robots.txt (once per site) and refuses a disallowed URL, naming the rule. The command line has no switch to turn this off.

## What the 34 tests show

| File | Tests | Covers |
|---|---|---|
| `extract.test.ts` | 9 | all 23 products across 5 pages, exact request order, CSV and JSON agree, `maxPages`, the polite gap between requests, a 503 retried once and then succeeding, a clear failure with retries off, no retry on a 404, robots refusal with no request made, a delayed page (a naive read sees nothing; the kit waits and gets all 3 rows), a clear timeout when the data is too slow |
| `fill-form.test.ts` | 4 | 3 good rows submitted and 3 bad rows logged with exact errors, resume after an injected crash with no row submitted twice, re-run behaviour with and without `skipFailed`, robots refusal before the form is opened |
| `snapshot.test.ts` | 4 | real PNG and PDF files, waiting for a late page, robots refusal, a 404 reported as an error |
| `robots.test.ts` | 9 | prefix rules, empty Disallow, longest match wins and Allow wins a tie, `*` and `$`, a group naming this kit beats `*`, robots.txt fetched once per site, a missing robots.txt, an unreadable robots.txt |
| `csv.test.ts` | 4 | quotes, newlines, CRLF, BOM, header-keyed records, round trip |
| `cli.test.ts` | 4 | the command line end to end, exit codes 0, 1 and 2, usage errors |

Deliberately breaking the code in a scratch copy (ten different ways, for example removing a robots check, forcing zero retries, removing the polite delay, not skipping finished rows on resume, letting a bad row abort the batch) made a test fail every time.

## What this will not do

- **No login handling and no CAPTCHA handling.** It does not sign in to sites, store passwords or cookies, or solve or get around CAPTCHAs.
- **No anti-bot evasion.** No proxies, no rotating identities, no spoofed browser fingerprints, no hiding that it is automated.
- **No use against sites whose terms forbid automation.** Check a site's terms and robots.txt before pointing this at it. robots.txt is a courtesy signal, not legal permission.
- **No bulk lead-list scraping.**
- **Not a way around a site's own limits.** If a site offers an API or an export, use that first.

## Limits (read these before relying on it)

- **Only ever run against the local fixture site.** Every test and example uses the fictional site in `fixtures/`. It has never been pointed at a real third-party site, so real-world surprises (consent banners, lazy loading, odd markup, anti-automation) are untested.
- **The extractors are written for the fixture's markup.** On a real site you change the selectors in `src/extract.ts` and `src/fill-form.ts`; that is the normal work of a job, not something the kit does for you.
- **One browser, one machine, one pace.** Google Chrome only, sequential (no parallel pages), tested on macOS with Node 25. Headless runs only were tested; `--headed` exists but was not exercised.
- **The robots.txt reader is partial.** It handles groups, Allow, Disallow, longest match, `*` and `$`. It ignores Crawl-delay and Sitemap lines and does not handle percent-encoding edge cases. If robots.txt answers with a server error it refuses to proceed.
- **Retries cover page-load failures** (HTTP 5xx, 429, timeouts). They do not cover a failure in the middle of a form submission: a row that failed after the site accepted it could be submitted twice on a re-run. Whether that matters depends on the site.
- **CSV reader is minimal** (quotes, commas, newlines, BOM). No other delimiters or encodings.
- **Not production code.** No logging framework, no scheduling, no secrets handling, no monitoring.

## Layout

```
src/        browser.ts, extract.ts, fill-form.ts, snapshot.ts, robots.ts, retry.ts, csv.ts, fixture-server.ts, cli.ts
fixtures/   the fictional site: products.json, form.html, delayed.html, robots.txt
examples/   rows.csv (6 rows: 3 good, 3 bad on purpose)
tests/      vitest suites, one file per area
```

`npm test` runs the suite (about 30 seconds, it starts Chrome). `npm run typecheck` runs `tsc --noEmit`.
