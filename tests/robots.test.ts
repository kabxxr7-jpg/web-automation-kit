import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServer } from "../src/fixture-server";
import { RobotsChecker, RobotsDisallowedError, RobotsUnavailableError, evaluate, parseRobots } from "../src/robots";
import { fakeFetch } from "./helpers";

describe("parseRobots and evaluate", () => {
  it("disallows by prefix and allows everything else", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private/\n");
    expect(evaluate(rules, "/private/report").allowed).toBe(false);
    expect(evaluate(rules, "/private/report").rule).toBe("Disallow: /private/");
    expect(evaluate(rules, "/products?page=2").allowed).toBe(true);
  });

  it("treats an empty Disallow as allow-everything and ignores comments", () => {
    const rules = parseRobots("# hello\nUser-agent: *  # all\nDisallow:\n");
    expect(evaluate(rules, "/anything").allowed).toBe(true);
  });

  it("lets the longest matching rule win, and Allow win a tie", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /docs/\nAllow: /docs/public/\n");
    expect(evaluate(rules, "/docs/secret").allowed).toBe(false);
    expect(evaluate(rules, "/docs/public/readme").allowed).toBe(true);
    const tie = parseRobots("User-agent: *\nDisallow: /x\nAllow: /x\n");
    expect(evaluate(tie, "/x").allowed).toBe(true);
  });

  it("supports * wildcards and the $ end anchor", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/cache\n");
    expect(evaluate(rules, "/files/a.pdf").allowed).toBe(false);
    expect(evaluate(rules, "/files/a.pdf?x=1").allowed).toBe(true); // $ means the path must END in .pdf
    expect(evaluate(rules, "/tmp123/cache").allowed).toBe(false);
    expect(evaluate(rules, "/files/a.html").allowed).toBe(true);
  });

  it("prefers a group that names this kit over the * group", () => {
    const text = "User-agent: *\nDisallow: /\n\nUser-agent: web-automation-kit\nDisallow: /nope/\n";
    const rules = parseRobots(text, "web-automation-kit");
    expect(evaluate(rules, "/products").allowed).toBe(true);
    expect(evaluate(rules, "/nope/x").allowed).toBe(false);
    expect(evaluate(parseRobots(text, "someone-else"), "/products").allowed).toBe(false);
  });
});

describe("RobotsChecker against the fixture site", () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it("allows public pages and refuses the disallowed path with the rule that matched", async () => {
    const robots = new RobotsChecker();
    await expect(robots.assertAllowed(`${server.url}/products?page=3`)).resolves.toBeUndefined();
    const err = await robots.assertAllowed(`${server.url}/private/report`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RobotsDisallowedError);
    expect((err as RobotsDisallowedError).rule).toBe("Disallow: /private/");
  });

  it("fetches robots.txt once per origin, however many URLs are checked", async () => {
    const before = server.requests.filter((r) => r.url === "/robots.txt").length;
    const robots = new RobotsChecker();
    await robots.check(`${server.url}/a`);
    await robots.check(`${server.url}/b`);
    await robots.check(`${server.url}/c`);
    expect(server.requests.filter((r) => r.url === "/robots.txt").length - before).toBe(1);
  });
});

describe("RobotsChecker edge cases", () => {
  it("treats a missing robots.txt (404) as nothing disallowed", async () => {
    const robots = new RobotsChecker({ fetchImpl: fakeFetch("not found", 404) });
    await expect(robots.assertAllowed("http://example.test/anything")).resolves.toBeUndefined();
  });

  it("refuses to proceed when robots.txt cannot be read (5xx), because the rules are unknown", async () => {
    const robots = new RobotsChecker({ fetchImpl: fakeFetch("oops", 503) });
    await expect(robots.assertAllowed("http://example.test/anything")).rejects.toBeInstanceOf(RobotsUnavailableError);
  });
});
