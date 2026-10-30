import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { kitUserAgent } from "./browser";
import { toCsv } from "./csv";
import { sleep } from "./retry";
import { RobotsChecker } from "./robots";

/**
 * A polite link checker for ONE site.
 *
 * - It crawls pages of the start URL's origin (breadth first, at most `maxPages` page requests).
 * - robots.txt of that origin is respected: a disallowed page is never requested, and is listed as skipped.
 * - Links to other origins get one status request (HEAD, or GET if the server rejects HEAD). They are never crawled.
 * - Redirects are followed by hand, at most 3, so a chain can be reported. One hop is "redirect", two or more is a "chain".
 * - No login, no forms, no JavaScript: it reads the HTML that the server sends.
 */

export const MAX_REDIRECTS = 3;
const ASSET = /\.(pdf|zip|gz|jpe?g|png|gif|svg|webp|ico|css|js|mjs|json|xml|mp3|mp4|mov|avi|docx?|xlsx?|pptx?)$/i;

export type LinkResult = "ok" | "redirect" | "redirect-chain" | "broken" | "skipped-robots";

export interface LinkOccurrence {
  page: string;
  anchorText: string;
}

export interface CheckedLink {
  url: string;
  scope: "internal" | "external";
  result: LinkResult;
  /** "200", "404", "timeout after 800 ms", "connection refused", "too many redirects (more than 3)", "disallowed by robots.txt (Disallow: /x)". */
  status: string;
  finalUrl: string;
  hops: number;
  chain: string[];
  /** True when the page was fetched in full by the crawler (as opposed to only a status request). */
  crawled: boolean;
  occurrences: LinkOccurrence[];
}

export interface CheckLinksSummary {
  pagesFetched: number;
  linksChecked: number;
  occurrences: number;
  brokenInternal: number;
  brokenExternal: number;
  redirectChains: number;
  singleRedirects: number;
  skippedRobots: number;
  skippedNonHttp: number;
  /** True when the page limit stopped the crawl while pages were still waiting. */
  truncated: boolean;
}

export interface CheckLinksResult {
  startUrl: string;
  origin: string;
  maxPages: number;
  pages: string[];
  links: CheckedLink[];
  summary: CheckLinksSummary;
}

export interface CheckLinksOptions {
  startUrl: string;
  /** Page requests the crawler may make. Default 50. */
  maxPages?: number;
  /** Pause between any two requests. Default 300 ms. */
  delayMs?: number;
  /** Per request. Default 8000 ms. */
  timeoutMs?: number;
  userAgent?: string;
  robots?: RobotsChecker;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

// ---------- HTML link extraction ----------

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ");

function attr(tagAttrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(tagAttrs);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

export interface ExtractedLink {
  url: string;
  anchorText: string;
}

/**
 * Reads every `<a href>` in the HTML. Regex based, so it is deliberately simple: it does not run scripts,
 * ignores `<base href>`, and does not read links that JavaScript adds later.
 */
export function extractLinks(html: string, baseUrl: string): { links: ExtractedLink[]; skippedNonHttp: number } {
  const links: ExtractedLink[] = [];
  let skippedNonHttp = 0;
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutComments))) {
    const href = attr(m[1] ?? "", "href");
    if (href === undefined) continue;
    const trimmed = href.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue; // same-page anchors are not links to check
    let resolved: URL;
    try {
      resolved = new URL(trimmed, baseUrl);
    } catch {
      skippedNonHttp++;
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      skippedNonHttp++;
      continue;
    }
    resolved.hash = "";
    const text = decodeEntities((m[2] ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    links.push({ url: resolved.href, anchorText: text.length > 80 ? text.slice(0, 77) + "..." : text });
  }
  return { links, skippedNonHttp };
}

// ---------- requests ----------

interface Probe {
  /** HTTP status of the last response, or null when the request itself failed. */
  status: number | null;
  error?: string;
  finalUrl: string;
  chain: string[];
  hops: number;
  contentType: string;
  body?: string;
  skippedRule?: string;
}

function describeError(e: unknown, timeoutMs: number): string {
  const err = e as { name?: string; code?: string; cause?: { code?: string; message?: string }; message?: string };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `timeout after ${timeoutMs} ms`;
  const code = err?.cause?.code ?? err?.code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host not found";
  if (code === "ECONNRESET") return "connection reset";
  if (code === "UND_ERR_CONNECT_TIMEOUT") return `timeout after ${timeoutMs} ms`;
  return code ?? err?.cause?.message ?? err?.message ?? String(e);
}

export async function checkLinks(opts: CheckLinksOptions): Promise<CheckLinksResult> {
  const start = new URL(opts.startUrl);
  start.hash = "";
  const origin = start.origin;
  const maxPages = opts.maxPages ?? 50;
  const delayMs = opts.delayMs ?? 300;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const wait = opts.sleep ?? sleep;
  const doFetch = opts.fetchImpl ?? fetch;
  const robots = opts.robots ?? new RobotsChecker({ userAgent: undefined, fetchImpl: opts.fetchImpl });
  const userAgent = opts.userAgent ?? kitUserAgent();

  let requestsMade = 0;
  const throttle = async (): Promise<void> => {
    if (requestsMade > 0 && delayMs > 0) await wait(delayMs);
    requestsMade++;
  };

  /** Requests a URL, following up to MAX_REDIRECTS redirects by hand. */
  async function probe(url: string, method: "GET" | "HEAD", wantBody: boolean): Promise<Probe> {
    let current = url;
    const chain: string[] = [];
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (new URL(current).origin === origin) {
        const verdict = await robots.check(current);
        if (!verdict.allowed) return { status: null, finalUrl: current, chain, hops: hop, contentType: "", skippedRule: verdict.rule ?? "Disallow" };
      }
      await throttle();
      let res: Response;
      try {
        res = await doFetch(current, { method, redirect: "manual", headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        return { status: null, error: describeError(e, timeoutMs), finalUrl: current, chain, hops: hop, contentType: "" };
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.arrayBuffer().catch(() => undefined);
        chain.push(current);
        if (hop === MAX_REDIRECTS) {
          return { status: null, error: `too many redirects (more than ${MAX_REDIRECTS})`, finalUrl: current, chain, hops: hop + 1, contentType: "" };
        }
        current = new URL(location, current).href;
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      let body: string | undefined;
      if (wantBody && method === "GET" && /text\/html|application\/xhtml/i.test(contentType) && res.status < 400) {
        try {
          body = (await res.text()).slice(0, 2_000_000);
        } catch (e) {
          return { status: null, error: describeError(e, timeoutMs), finalUrl: current, chain, hops: hop, contentType };
        }
      } else {
        await res.arrayBuffer().catch(() => undefined);
      }
      return { status: res.status, finalUrl: current, chain, hops: hop, contentType, body };
    }
    return { status: null, error: "too many redirects", finalUrl: current, chain, hops: MAX_REDIRECTS + 1, contentType: "" };
  }

  const links = new Map<string, CheckedLink>();
  const pages: string[] = [];
  const crawledFinal = new Set<string>();
  let skippedNonHttp = 0;
  let truncated = false;

  const note = (target: string, from: string, anchorText: string): CheckedLink => {
    let link = links.get(target);
    if (!link) {
      link = {
        url: target,
        scope: new URL(target).origin === origin ? "internal" : "external",
        result: "ok",
        status: "",
        finalUrl: target,
        hops: 0,
        chain: [],
        crawled: false,
        occurrences: [],
      };
      links.set(target, link);
    }
    link.occurrences.push({ page: from, anchorText });
    return link;
  };

  const fill = (link: CheckedLink, p: Probe): void => {
    link.finalUrl = p.finalUrl;
    link.hops = p.hops;
    link.chain = p.chain;
    if (p.skippedRule) {
      link.result = "skipped-robots";
      link.status = `disallowed by robots.txt (${p.skippedRule})`;
    } else if (p.status === null) {
      link.result = "broken";
      link.status = p.error ?? "request failed";
    } else if (p.status >= 400) {
      link.result = "broken";
      link.status = String(p.status);
    } else {
      link.status = String(p.status);
      link.result = p.hops >= 2 ? "redirect-chain" : p.hops === 1 ? "redirect" : "ok";
    }
  };

  // ---- phase 1: crawl pages of this origin ----
  const queue: string[] = [start.href];
  const queued = new Set<string>(queue);
  note(start.href, "(start URL)", "start");
  let pagesFetched = 0;

  while (queue.length > 0) {
    if (pagesFetched >= maxPages) {
      truncated = true;
      break;
    }
    const pageUrl = queue.shift()!;
    const link = links.get(pageUrl)!;
    const p = await probe(pageUrl, "GET", true);
    if (!p.skippedRule) pagesFetched++;
    link.crawled = !p.skippedRule;
    fill(link, p);
    if (p.skippedRule || p.status === null || p.status >= 400) continue;
    // Two URLs can end at the same page (a redirect). Read its links only once.
    if (crawledFinal.has(p.finalUrl)) continue;
    crawledFinal.add(p.finalUrl);
    pages.push(p.finalUrl);
    if (p.body === undefined) continue;

    const found = extractLinks(p.body, p.finalUrl);
    skippedNonHttp += found.skippedNonHttp;
    for (const l of found.links) {
      note(l.url, p.finalUrl, l.anchorText);
      const target = new URL(l.url);
      if (target.origin === origin && !ASSET.test(target.pathname) && !queued.has(l.url)) {
        queued.add(l.url);
        queue.push(l.url);
      }
    }
  }

  // ---- phase 2: one status request for every other link (assets, external sites, pages beyond the limit) ----
  for (const link of links.values()) {
    if (link.crawled || link.result === "skipped-robots") continue;
    if (link.url === start.href) continue;
    let p = await probe(link.url, "HEAD", false);
    if (p.status === 405 || p.status === 501) p = await probe(link.url, "GET", false);
    fill(link, p);
  }

  // The start URL has no real "found on"; do not list it as a link anyone could fix.
  const startLink = links.get(start.href);
  if (startLink) startLink.occurrences = startLink.occurrences.filter((o) => o.page !== "(start URL)");
  const list = [...links.values()].filter((l) => l.url !== start.href || l.occurrences.length > 0 || l.result === "broken" || l.result === "skipped-robots");

  const summary: CheckLinksSummary = {
    pagesFetched,
    linksChecked: list.length,
    occurrences: list.reduce((n, l) => n + l.occurrences.length, 0),
    brokenInternal: list.filter((l) => l.scope === "internal" && l.result === "broken").length,
    brokenExternal: list.filter((l) => l.scope === "external" && l.result === "broken").length,
    redirectChains: list.filter((l) => l.result === "redirect-chain").length,
    singleRedirects: list.filter((l) => l.result === "redirect").length,
    skippedRobots: list.filter((l) => l.result === "skipped-robots").length,
    skippedNonHttp,
    truncated,
  };
  return { startUrl: start.href, origin, maxPages, pages, links: list, summary };
}

// ---------- reports ----------

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

function foundOn(l: CheckedLink, limit = 5): string {
  const unique = [...new Map(l.occurrences.map((o) => [`${o.page}|${o.anchorText}`, o])).values()];
  const shown = unique.slice(0, limit).map((o) => `${new URL(o.page).pathname} ("${cell(o.anchorText) || "no text"}")`);
  const more = unique.length - shown.length;
  return shown.join("; ") + (more > 0 ? `; and ${more} more` : "");
}

export function renderMarkdown(r: CheckLinksResult): string {
  const s = r.summary;
  const rel = (u: string): string => (u.startsWith(r.origin) ? u.slice(r.origin.length) || "/" : u);
  const out: string[] = [];
  out.push(`# Link check: ${r.startUrl}`);
  out.push("");
  out.push(`${s.pagesFetched} page(s) fetched (limit ${r.maxPages}${s.truncated ? ", reached: the site has more pages than were crawled" : ""}); ${s.linksChecked} distinct link(s) checked.`);
  out.push("");
  out.push("| Result | Count |");
  out.push("|---|---|");
  out.push(`| Broken internal links | ${s.brokenInternal} |`);
  out.push(`| Broken external links | ${s.brokenExternal} |`);
  out.push(`| Redirect chains (2 or more hops) | ${s.redirectChains} |`);
  out.push(`| Single redirects | ${s.singleRedirects} |`);
  out.push(`| Skipped because of robots.txt | ${s.skippedRobots} |`);
  out.push(`| Skipped (mailto, tel and similar) | ${s.skippedNonHttp} |`);

  const section = (title: string, rows: CheckedLink[], columns: (l: CheckedLink) => string[], head: string[]): void => {
    out.push("");
    out.push(`## ${title}`);
    out.push("");
    if (rows.length === 0) {
      out.push("None.");
      return;
    }
    out.push(`| ${head.join(" | ")} |`);
    out.push(`|${head.map(() => "---").join("|")}|`);
    for (const l of rows) out.push(`| ${columns(l).map(cell).join(" | ")} |`);
  };

  const broken = (scope: "internal" | "external"): CheckedLink[] => r.links.filter((l) => l.scope === scope && l.result === "broken");
  section("Broken internal links", broken("internal"), (l) => [rel(l.url), l.status, foundOn(l)], ["Link", "Status", "Found on (anchor text)"]);
  section("Broken external links", broken("external"), (l) => [l.url, l.status, foundOn(l)], ["Link", "Status", "Found on (anchor text)"]);
  section(
    "Redirect chains",
    r.links.filter((l) => l.result === "redirect-chain"),
    (l) => [rel(l.url), `${l.hops} hops`, [...l.chain.map(rel), rel(l.finalUrl)].join(" -> "), foundOn(l)],
    ["Link", "Hops", "Path", "Found on (anchor text)"],
  );
  section(
    "Single redirects (usually fine; update the link if you can)",
    r.links.filter((l) => l.result === "redirect"),
    (l) => [rel(l.url), rel(l.finalUrl), foundOn(l)],
    ["Link", "Now goes to", "Found on (anchor text)"],
  );
  section(
    "Skipped because robots.txt disallows them (not requested)",
    r.links.filter((l) => l.result === "skipped-robots"),
    (l) => [rel(l.url), l.status, foundOn(l)],
    ["Link", "Rule", "Found on (anchor text)"],
  );
  out.push("");
  out.push("Pages fetched:");
  out.push("");
  for (const p of r.pages) out.push(`- ${rel(p)}`);
  out.push("");
  return out.join("\n");
}

export function reportRows(r: CheckLinksResult): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const l of r.links) {
    const occ = l.occurrences.length > 0 ? l.occurrences : [{ page: "", anchorText: "" }];
    for (const o of occ) {
      rows.push({
        scope: l.scope,
        result: l.result,
        status: l.status,
        url: l.url,
        final_url: l.finalUrl,
        redirect_hops: l.hops,
        found_on: o.page,
        anchor_text: o.anchorText,
      });
    }
  }
  return rows;
}

export async function writeReports(r: CheckLinksResult, outDir: string): Promise<{ markdownPath: string; csvPath: string }> {
  await mkdir(outDir, { recursive: true });
  const markdownPath = path.join(outDir, "link-report.md");
  const csvPath = path.join(outDir, "link-report.csv");
  await writeFile(markdownPath, renderMarkdown(r));
  await writeFile(csvPath, toCsv(["scope", "result", "status", "url", "final_url", "redirect_hops", "found_on", "anchor_text"], reportRows(r)));
  return { markdownPath, csvPath };
}
