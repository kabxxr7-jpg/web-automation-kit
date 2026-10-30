# web-automation-kit

A small, tested starting point for "automate this repetitive task in a browser" jobs: pull a paginated list into CSV and JSON, fill a web form from a spreadsheet row by row, save a full-page screenshot and PDF of a page, and (new) check a small site for broken links and test whether its contact form really works. It drives the Google Chrome already installed on the machine through Playwright.

**Status:** a proof project (63 tests, run locally, against a small fictional site that this repo serves on localhost). Not used in production or by any client. See "Limits" for what was not verified.

## What is in it

| Command | What it does |
|---|---|
| `extract <url>` | Walks a paginated product list through its "next" links, waits for the list to appear on each page, retries flaky loads, pauses politely between pages, and writes `products.csv` and `products.json`. `--mode delayed` reads a page that fills itself in late. |
| `fill-form <url>` | Reads rows from a CSV, submits the form once per row, and appends one line per row to a results log (`ok`, or the exact error). A crash or a re-run picks up where it stopped. |
| `snapshot <url>` | Saves a full-page PNG and an A4 PDF of one URL. |
| `check-links <url>` | Crawls one site politely and writes a Markdown and a CSV report of broken internal and external links, redirect chains, and what robots.txt kept it out of. See "Site checks". |
| `test-form <url>` | Fills a contact-style form, submits it once for real, and says whether it worked, failed with a message, or failed silently. Localhost only unless you confirm you own the site. See "Site checks". |
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
npm run kit -- check-links http://127.0.0.1:8788/site/ --out out/links
npm run kit -- test-form http://127.0.0.1:8788/site/contact --fields "name=Ada Example,email=ada@example.com,message=Hello there" --expect-text "Thank you"
```

Needs Google Chrome installed (no browser download) and a recent Node; it was developed and tested on Node 25 only, other versions are untested. Options: `--delay-ms` (pause between page requests, default 500), `--retries` (per page, default 2), `--timeout-ms` (per waiting step), `--max-pages`, `--skip-failed`, `--headed`. Exit codes: 0 all good, 1 some rows failed, 2 refused by robots.txt or bad usage, 3 unexpected error.

## Site checks

Two commands for the usual "my small business website has problems" job. Both ran only against the fictional site this repo serves at `/site` (a home page, an about page, a services page and several contact forms).

### `check-links`

```bash
npm run kit -- check-links http://127.0.0.1:8788/site/ --out out/links
```

It reads the HTML of each page (no JavaScript is run), follows same-site links breadth first up to `--max-pages` (default 50), waits `--delay-ms` (default 300) between requests, and gives every other link one status request (HEAD, or GET if the server refuses HEAD). Links to other sites are never crawled. Redirects are followed by hand, at most 3, so a chain can be shown: one hop is listed as a "single redirect", two or more as a "redirect chain". Pages that robots.txt disallows are never requested and are listed as skipped, not as broken. Exit code 1 means an internal link is broken; a broken external link is reported but does not fail the run.

Real output from the fixture site (the external link points at a localhost port that nothing listens on; its number differs each run):

```
{
  "pagesFetched": 10,
  "linksChecked": 12,
  "occurrences": 24,
  "brokenInternal": 3,
  "brokenExternal": 1,
  "redirectChains": 1,
  "singleRedirects": 1,
  "skippedRobots": 1,
  "skippedNonHttp": 2,
  "truncated": false,
  "markdown": "out/links/link-report.md",
  "csv": "out/links/link-report.csv"
}
```

The report, `link-report.md` (excerpt; `link-report.csv` has one row per place a link appears, with the page it was found on and its anchor text):

```markdown
## Broken internal links

| Link | Status | Found on (anchor text) |
|---|---|---|
| /site/team | 404 | /site/about ("Meet the team") |
| /site/chain/5 | too many redirects (more than 3) | /site/about ("Archive") |
| /site/hang | timeout after 800 ms | /site/services ("Brochure (very slow)") |

## Broken external links

| Link | Status | Found on (anchor text) |
|---|---|---|
| http://127.0.0.1:56788/partner | connection refused | /site/ ("Partner 1") |

## Redirect chains

| Link | Hops | Path | Found on (anchor text) |
|---|---|---|---|
| /site/old-page | 2 hops | /site/old-page -> /site/older-page -> /site/new-page | /site/services ("Our old price list") |

## Single redirects (usually fine; update the link if you can)

| Link | Now goes to | Found on (anchor text) |
|---|---|---|
| /site/shop | /site/services | /site/ ("Shop") |
```

### `test-form`

```bash
npm run kit -- test-form http://127.0.0.1:8788/site/contact \
  --fields "name=Ada Example,email=ada@example.com,message=Hello there" --expect-text "Thank you"
```

It opens the page in Chrome, finds the form that has all the fields you named, fills them, clicks submit once, and waits for the answer. Then it says which of these happened:

| `status` | Meaning |
|---|---|
| `ok` | the text you expected (or a success message it recognises by its class) appeared and no error was shown |
| `validation-error` | the page showed an error message (it is quoted), or the server rejected the data |
| `silent-failure` | the server answered normally but neither your text nor any error appeared: the form may be broken without saying so |
| `server-error` | the submission got a 5xx answer or failed on the network |
| `no-submission` | clicking submit sent nothing, for example because the browser's own validation blocked it (its message is shown) |
| `field-missing` | the form has no field with a name you gave; nothing was submitted |
| `page-error` / `unknown` | the page did not load / it submitted fine but no success message was recognised (pass `--expect-text`) |

Exit code 0 only for `ok`. Real output for a form that silently fails (HTTP 200, no thank-you, no error):

```
{
  "pageUrl": "http://127.0.0.1:8788/site/contact-silent",
  "finalUrl": "http://127.0.0.1:8788/site/contact-silent",
  "pageTitle": "Contact us (fictional fixture)",
  "status": "silent-failure",
  "expectText": "Thank you",
  "expectTextFound": false,
  "visibleErrors": [],
  "nativeValidationMessages": [],
  "submissions": [
    {
      "method": "POST",
      "url": "/site/contact-silent",
      "status": 200
    }
  ],
  "missingFields": [],
  "notes": [
    "The server answered HTTP 200 but \"Thank you\" never appeared and no error was shown. Nothing visible says whether the message was received."
  ]
}
```

and for a form that rejects bad input (a 422 and a visible message):

```
{
  "pageUrl": "http://127.0.0.1:8788/site/contact",
  "finalUrl": "http://127.0.0.1:8788/site/contact",
  "pageTitle": "Contact us (fictional fixture)",
  "status": "validation-error",
  "expectText": "Thank you",
  "expectTextFound": false,
  "visibleErrors": [
    "Error: Email address is not valid"
  ],
  "nativeValidationMessages": [],
  "submissions": [
    {
      "method": "POST",
      "url": "/site/contact",
      "status": 422
    }
  ],
  "missingFields": [],
  "notes": []
}
```

**It sends a real submission**, so it only runs on localhost. For any other host it stops with exit code 2 before opening a browser, unless you pass `--i-own-this-site` to confirm you own the site or are authorised to test it. robots.txt is checked first, as for every other command.

## How it avoids the usual traps

- **No fixed sleeps for loading.** Pages are read after a condition is true (the product list is visible, the delayed list says `data-ready="true"`, the result message appeared). The only pauses are the polite delay you configure and the backoff between retries.
- **Clear timeouts.** Every waiting step has a timeout and fails with Playwright's own message instead of hanging.
- **One bad row never stops a batch.** The exact error is logged and the next row runs.
- **Resumable.** The results log is appended after every row. Re-running skips rows that already succeeded; rows that failed are tried again unless `--skip-failed` is set.
- **Honest about itself.** It sends a `web-automation-kit/0.1` User-Agent. It does not disguise itself as a person's browser.
- **Respects robots.txt.** Before any page is requested the kit reads the site's robots.txt (once per site) and refuses a disallowed URL, naming the rule. The command line has no switch to turn this off.

## What the 63 tests show

| File | Tests | Covers |
|---|---|---|
| `extract.test.ts` | 9 | all 23 products across 5 pages, exact request order, CSV and JSON agree, `maxPages`, the polite gap between requests, a 503 retried once and then succeeding, a clear failure with retries off, no retry on a 404, robots refusal with no request made, a delayed page (a naive read sees nothing; the kit waits and gets all 3 rows), a clear timeout when the data is too slow |
| `fill-form.test.ts` | 4 | 3 good rows submitted and 3 bad rows logged with exact errors, resume after an injected crash with no row submitted twice, re-run behaviour with and without `skipFailed`, robots refusal before the form is opened |
| `snapshot.test.ts` | 4 | real PNG and PDF files, waiting for a late page, robots refusal, a 404 reported as an error |
| `robots.test.ts` | 9 | prefix rules, empty Disallow, longest match wins and Allow wins a tie, `*` and `$`, a group naming this kit beats `*`, robots.txt fetched once per site, a missing robots.txt, an unreadable robots.txt |
| `csv.test.ts` | 4 | quotes, newlines, CRLF, BOM, header-keyed records, round trip |
| `cli.test.ts` | 4 | the command line end to end, exit codes 0, 1 and 2, usage errors |
| `check-links.test.ts` | 11 | link extraction (quoted and bare hrefs, relative links, fragments, mailto, tel, comments); a broken internal link found with the page it is on and its anchor text; a 2-hop redirect chain flagged with its path, a single redirect listed separately, a chain of 5 given up on after 3; a link that never answers reported as a timeout; a dead external link reported without failing an otherwise clean section; another site given one HEAD request and never crawled; `--max-pages` respected and reported; a robots-disallowed link skipped and never requested; a disallowed start page and an unreadable robots.txt refused; no POST sent and a polite gap between page requests; the Markdown and CSV reports |
| `test-form.test.ts` | 14 | field parsing; localhost allowed and every other host (including LAN addresses) refused, before a browser page is opened; a form that works (`ok`, with the POST and its 200); a validation error (the exact visible message and the 422); an error shown with HTTP 200; the silent failure; a success recognised by class; `unknown` when it cannot tell; a 500; the browser's own validation blocking the submit; fields the form lacks; a form page that 404s; robots refusal with no request made |
| `site-cli.test.ts` | 4 | `check-links` exit 1 with a broken internal link and exit 0 when only an external link is broken, both reports written; `test-form` exit 0 and 1; exit 2 and no output for a non-local site |

Deliberately breaking the code in a scratch copy (ten different ways, for example removing a robots check, forcing zero retries, removing the polite delay, not skipping finished rows on resume, letting a bad row abort the batch) made a test fail every time. The site checks were broken fifteen more ways (skipping the robots check, ignoring `--max-pages`, a wrong chain threshold, counting external links as internal, removing the delay, crawling other sites, using GET instead of HEAD, not skipping mailto links, a redirect limit of 10, allowing remote hosts, ignoring visible errors, reporting a silent failure as ok, ignoring missing fields, a 5xx treated as fine); one was missed at first because the fixture only had an error form that answered 422, so a form that shows an error with HTTP 200 was added, and then every break was caught.

## What this will not do

- **No login handling and no CAPTCHA handling.** It does not sign in to sites, store passwords or cookies, or solve or get around CAPTCHAs.
- **No anti-bot evasion.** No proxies, no rotating identities, no spoofed browser fingerprints, no hiding that it is automated.
- **No use against sites whose terms forbid automation.** Check a site's terms and robots.txt before pointing this at it. robots.txt is a courtesy signal, not legal permission.
- **No bulk lead-list scraping.**
- **`check-links` never submits forms or logs in, and `test-form` never runs against a site you have not said you own.** Submitting a real form can send a real email.
- **Not a way around a site's own limits.** If a site offers an API or an export, use that first.

## Limits (read these before relying on it)

- **Only ever run against the local fixture site.** Every test and example uses the fictional site in `fixtures/`. It has never been pointed at a real third-party site, so real-world surprises (consent banners, lazy loading, odd markup, anti-automation) are untested.
- **The extractors are written for the fixture's markup.** On a real site you change the selectors in `src/extract.ts` and `src/fill-form.ts`; that is the normal work of a job, not something the kit does for you.
- **One browser, one machine, one pace.** Google Chrome only, sequential (no parallel pages), tested on macOS with Node 25. Headless runs only were tested; `--headed` exists but was not exercised.
- **The robots.txt reader is partial.** It handles groups, Allow, Disallow, longest match, `*` and `$`. It ignores Crawl-delay and Sitemap lines and does not handle percent-encoding edge cases. If robots.txt answers with a server error it refuses to proceed.
- **Retries cover page-load failures** (HTTP 5xx, 429, timeouts). They do not cover a failure in the middle of a form submission: a row that failed after the site accepted it could be submitted twice on a re-run. Whether that matters depends on the site.
- **The site checks were only run against the fixture site.** `check-links` reads HTML with a simple pattern match: it ignores `<base href>`, does not run JavaScript (links a script adds later are not seen), checks only `<a>` links (not images, scripts or stylesheets) and treats common file types as links to status-check, not pages to read. It is not a replacement for a proper SEO crawler.
- **`test-form` is heuristic about success and errors.** It looks for the text you give, a few common success and error markup patterns (including ones used by popular WordPress form plugins, which were not tested against those plugins), and the browser's own validation messages. A form that needs a CAPTCHA, a login, a file upload or several steps is outside what it does. It cannot tell whether an email was actually delivered, only what the page and the server said.
- **CSV reader is minimal** (quotes, commas, newlines, BOM). No other delimiters or encodings.
- **Not production code.** No logging framework, no scheduling, no secrets handling, no monitoring.

## Layout

```
src/        browser.ts, extract.ts, fill-form.ts, snapshot.ts, check-links.ts, test-form.ts, robots.ts, retry.ts, csv.ts, fixture-server.ts, cli.ts
fixtures/   the fictional site: products.json, form.html, delayed.html, robots.txt (the /site pages are built in fixture-server.ts)
examples/   rows.csv (6 rows: 3 good, 3 bad on purpose)
tests/      vitest suites, one file per area
```

`npm test` runs the suite (about 30 seconds, it starts Chrome). `npm run typecheck` runs `tsc --noEmit`.
