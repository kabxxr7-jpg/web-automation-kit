import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLinks, extractLinks, renderMarkdown, writeReports, type CheckedLink, type CheckLinksResult } from "../src/check-links";
import { parseCsv } from "../src/csv";
import { closedPort, startFixtureServer, type FixtureServer, type RequestRecord } from "../src/fixture-server";
import { RobotsChecker, RobotsUnavailableError } from "../src/robots";
import { fakeFetch, makeTmp, removeTmp } from "./helpers";

let server: FixtureServer;
let deadUrl: string;
let full: CheckLinksResult;
let fullRequests: RequestRecord[];

const find = (r: CheckLinksResult, suffix: string): CheckedLink => {
  const l = r.links.find((x) => x.url.endsWith(suffix));
  if (!l) throw new Error(`no link ending ${suffix}; have ${r.links.map((x) => x.url).join(", ")}`);
  return l;
};
const pathOf = (u: string): string => new URL(u).pathname;

beforeAll(async () => {
  deadUrl = `http://127.0.0.1:${await closedPort()}/gone`;
  server = await startFixtureServer({ externalLinks: [deadUrl] });
  // One full crawl of the small business site, shared by the tests that read its result.
  full = await checkLinks({ startUrl: `${server.url}/site/`, delayMs: 0, timeoutMs: 500 });
  fullRequests = [...server.requests];
});
afterAll(async () => {
  await server.close();
});

describe("extractLinks", () => {
  it("reads quoted and unquoted hrefs, resolves relative links, strips fragments and tags, and skips mailto, tel, anchors and comments", () => {
    const html = `<a href="/a">One</a> <A HREF='b.html'>Two <b>bold</b></A> <a href=c.html>Three</a>
      <a href="mailto:x@y.z">mail</a> <a href="tel:+100">tel</a> <a href="#top">top</a> <a name="x">no href</a>
      <!-- <a href="/commented">hidden</a> --> <a href="https://other.test/p?q=1&amp;r=2#frag">ext</a>`;
    const r = extractLinks(html, "http://s.test/dir/page");
    expect(r.links.map((l) => [l.url, l.anchorText])).toEqual([
      ["http://s.test/a", "One"],
      ["http://s.test/dir/b.html", "Two bold"],
      ["http://s.test/dir/c.html", "Three"],
      ["https://other.test/p?q=1&r=2", "ext"],
    ]);
    expect(r.skippedNonHttp).toBe(2); // mailto and tel; the "#top" anchor is not a link to check
  });
});

describe("check-links on the fixture business site", () => {
  it("finds the broken internal link and reports the page it was found on and its anchor text", () => {
    const team = find(full, "/site/team");
    expect(team).toMatchObject({ scope: "internal", result: "broken", status: "404" });
    expect(team.occurrences.map((o) => pathOf(o.page))).toEqual(["/site/about"]);
    expect(team.occurrences[0]?.anchorText).toBe("Meet the team");
  });

  it("flags a redirect chain (2 hops) with its path, reports a single redirect separately, and gives up after 3 redirects", () => {
    const chain = find(full, "/site/old-page");
    expect(chain.result).toBe("redirect-chain");
    expect(chain.hops).toBe(2);
    expect(chain.chain.map(pathOf)).toEqual(["/site/old-page", "/site/older-page"]);
    expect(pathOf(chain.finalUrl)).toBe("/site/new-page");

    const single = find(full, "/site/shop");
    expect(single).toMatchObject({ result: "redirect", hops: 1 });
    expect(pathOf(single.finalUrl)).toBe("/site/services");

    const tooMany = find(full, "/site/chain/5");
    expect(tooMany.result).toBe("broken");
    expect(tooMany.status).toContain("too many redirects");
    expect(full.summary.redirectChains).toBe(1);
    expect(full.summary.singleRedirects).toBe(1);
  });

  it("reports a link that never answers as a timeout instead of hanging", () => {
    const hang = find(full, "/site/hang");
    expect(hang).toMatchObject({ result: "broken", status: "timeout after 500 ms" });
  });

  it("reports a dead external link without crawling it, and it does not count as a broken internal link", async () => {
    const dead = full.links.find((l) => l.url === deadUrl)!;
    expect(dead).toMatchObject({ scope: "external", result: "broken", status: "connection refused" });
    expect(full.summary.brokenExternal).toBe(1);

    // On a section whose internal links are all fine, the external failure alone leaves brokenInternal at 0.
    const clean = await checkLinks({ startUrl: `${server.url}/site/clean/`, delayMs: 0, timeoutMs: 500 });
    expect(clean.summary).toMatchObject({ brokenInternal: 0, brokenExternal: 1, pagesFetched: 2 });
  });

  it("makes one status request to another origin and never crawls it", async () => {
    const other = await startFixtureServer({ externalLinks: [] });
    const site = await startFixtureServer({ externalLinks: [`${other.url}/site/`] });
    try {
      const r = await checkLinks({ startUrl: `${site.url}/site/clean/`, delayMs: 0, timeoutMs: 500 });
      expect(r.links.find((l) => l.url === `${other.url}/site/`)).toMatchObject({ scope: "external", result: "ok", status: "200" });
      // The other site saw exactly one HEAD request: no GET of the page, no robots.txt, nothing it links to.
      expect(other.requests.map((q) => `${q.method} ${q.url}`)).toEqual(["HEAD /site/"]);
    } finally {
      await site.close();
      await other.close();
    }
  });

  it("stops at --max-pages and says so", async () => {
    const s = await startFixtureServer({ externalLinks: [] });
    try {
      const r = await checkLinks({ startUrl: `${s.url}/site/`, maxPages: 2, delayMs: 0, timeoutMs: 500 });
      expect(r.summary.pagesFetched).toBe(2);
      expect(r.summary.truncated).toBe(true);
      const pageGets = s.requests.filter((q) => q.method === "GET" && q.url.startsWith("/site"));
      expect(pageGets).toHaveLength(2); // pages beyond the limit only got a status request (HEAD)
      expect(renderMarkdown(r)).toContain("reached");
    } finally {
      await s.close();
    }
  });

  it("honours robots.txt: lists a disallowed link as skipped and never requests it", () => {
    const staff = find(full, "/site/private/staff");
    expect(staff.result).toBe("skipped-robots");
    expect(staff.status).toContain("Disallow: /site/private/");
    expect(full.summary.skippedRobots).toBe(1);
    expect(fullRequests.some((q) => q.url.startsWith("/site/private"))).toBe(false);
    expect(full.summary.brokenInternal).toBe(3); // /site/team, /site/chain/5 and /site/hang; the skipped link is not counted as broken
  });

  it("refuses to start when robots.txt disallows the start page, and when robots.txt cannot be read", async () => {
    const s = await startFixtureServer({ externalLinks: [] });
    try {
      const blocked = await checkLinks({
        startUrl: `${s.url}/site/`,
        delayMs: 0,
        robots: new RobotsChecker({ fetchImpl: fakeFetch("User-agent: *\nDisallow: /site/\n") }),
      });
      expect(blocked.summary).toMatchObject({ pagesFetched: 0, skippedRobots: 1 });
      expect(s.requests).toHaveLength(0);

      await expect(
        checkLinks({ startUrl: `${s.url}/site/`, delayMs: 0, robots: new RobotsChecker({ fetchImpl: fakeFetch("", 503) }) }),
      ).rejects.toBeInstanceOf(RobotsUnavailableError);
    } finally {
      await s.close();
    }
  });

  it("is read-only and polite: no POST is ever sent, and there is a gap between page requests", async () => {
    expect(fullRequests.some((q) => q.method === "POST")).toBe(false);
    expect(server.contactSubmissions).toHaveLength(0);
    expect(server.silentSubmissions).toBe(0);

    const s = await startFixtureServer({ externalLinks: [] });
    try {
      await checkLinks({ startUrl: `${s.url}/site/`, maxPages: 3, delayMs: 120, timeoutMs: 500 });
      const gets = s.requests.filter((q) => q.method === "GET" && q.url.startsWith("/site"));
      expect(gets).toHaveLength(3);
      for (let i = 1; i < gets.length; i++) expect(gets[i]!.at - gets[i - 1]!.at).toBeGreaterThanOrEqual(100);
    } finally {
      await s.close();
    }
  });

  it("writes a Markdown report and a CSV with one row per place a link appears", async () => {
    const out = await makeTmp();
    try {
      const files = await writeReports(full, out);
      const md = await readFile(files.markdownPath, "utf8");
      expect(md).toContain("## Broken internal links");
      expect(md).toContain('/site/about ("Meet the team")');
      expect(md).toContain("Redirect chains");
      expect(path.basename(files.csvPath)).toBe("link-report.csv");

      const rows = parseCsv(await readFile(files.csvPath, "utf8"));
      expect(rows[0]).toEqual(["scope", "result", "status", "url", "final_url", "redirect_hops", "found_on", "anchor_text"]);
      const teamRow = rows.find((r) => r[3]?.endsWith("/site/team"));
      expect(teamRow?.[0]).toBe("internal");
      expect(teamRow?.[1]).toBe("broken");
      expect(teamRow?.[2]).toBe("404");
      expect(pathOf(teamRow?.[6] ?? "")).toBe("/site/about");
      expect(teamRow?.[7]).toBe("Meet the team");
    } finally {
      await removeTmp(out);
    }
  });
});
