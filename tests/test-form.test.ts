import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/browser";
import { startFixtureServer, type FixtureServer } from "../src/fixture-server";
import { RobotsChecker, RobotsDisallowedError } from "../src/robots";
import { assertTestableHost, parseFields, RemoteHostRefusedError, testForm } from "../src/test-form";
import { fakeFetch } from "./helpers";

let browser: Browser;
let server: FixtureServer;
const GOOD = { name: "Ada Example", email: "ada@example.com", message: "Hello there" };

beforeAll(async () => {
  browser = await launchBrowser();
  server = await startFixtureServer();
});
afterAll(async () => {
  await browser.close();
  await server.close();
});

describe("parseFields", () => {
  it("reads name=value pairs, escaped commas and repeated flags, and rejects a malformed pair", () => {
    expect(parseFields(["name=Ada,email=ada@example.com", "message=one\\, two"])).toEqual({
      name: "Ada",
      email: "ada@example.com",
      message: "one, two",
    });
    expect(parseFields(["name="])).toEqual({ name: "" });
    expect(() => parseFields(["justaword"])).toThrow(/name=value/);
  });
});

describe("assertTestableHost", () => {
  it("allows localhost addresses, refuses everything else unless the user confirms they own the site", () => {
    for (const ok of ["http://localhost:3000/", "http://127.0.0.1:8788/x", "http://[::1]:80/", "http://shop.localhost/contact"]) {
      expect(() => assertTestableHost(ok, false)).not.toThrow();
    }
    for (const no of ["http://example.com/contact", "https://www.some-shop.test/contact", "http://192.168.1.5/form", "http://10.0.0.2/"]) {
      expect(() => assertTestableHost(no, false)).toThrow(RemoteHostRefusedError);
    }
    expect(() => assertTestableHost("http://example.com/contact", true)).not.toThrow();
  });

  it("refuses a remote site before it opens a browser page or makes any request", async () => {
    const trap = { newContext: () => Promise.reject(new Error("the browser must not be used")) } as unknown as Browser;
    await expect(testForm({ browser: trap, pageUrl: "http://example.com/contact", fields: GOOD })).rejects.toBeInstanceOf(RemoteHostRefusedError);
  });
});

describe("test-form against the fixture contact forms", () => {
  it("reports ok when the expected thank-you text appears, with the submission's status code", async () => {
    const before = server.contactSubmissions.length;
    const r = await testForm({ browser, pageUrl: `${server.url}/site/contact`, fields: GOOD, expectText: "Thank you" });
    expect(r.status).toBe("ok");
    expect(r.expectTextFound).toBe(true);
    expect(r.visibleErrors).toEqual([]);
    expect(r.submissions).toEqual([{ method: "POST", url: "/site/contact", status: 200 }]);
    expect(server.contactSubmissions).toHaveLength(before + 1);
    expect(server.contactSubmissions.at(-1)).toEqual(GOOD);
  });

  it("reports a validation error with the exact visible message and the 422 the server sent", async () => {
    const r = await testForm({ browser, pageUrl: `${server.url}/site/contact`, fields: { ...GOOD, email: "not-an-email" }, expectText: "Thank you" });
    expect(r.status).toBe("validation-error");
    expect(r.expectTextFound).toBe(false);
    expect(r.visibleErrors).toEqual(["Error: Email address is not valid"]);
    expect(r.submissions).toEqual([{ method: "POST", url: "/site/contact", status: 422 }]);
  });

  it("reports a validation error even when the server answers 200 with a visible error message", async () => {
    const r = await testForm({ browser, pageUrl: `${server.url}/site/contact-soft`, fields: GOOD, expectText: "Thank you" });
    expect(r.status).toBe("validation-error");
    expect(r.visibleErrors).toEqual(["Error: The message could not be sent. Please try again later."]);
    expect(r.submissions).toEqual([{ method: "POST", url: "/site/contact-soft", status: 200 }]);
  });

  it("detects the silent failure: the server answers 200, nothing says it worked, nothing says it failed", async () => {
    const r = await testForm({ browser, pageUrl: `${server.url}/site/contact-silent`, fields: GOOD, expectText: "Thank you" });
    expect(r.status).toBe("silent-failure");
    expect(r.visibleErrors).toEqual([]);
    expect(r.expectTextFound).toBe(false);
    expect(r.submissions).toEqual([{ method: "POST", url: "/site/contact-silent", status: 200 }]);
    expect(server.silentSubmissions).toBeGreaterThanOrEqual(1);
  });

  it("recognises a success message by its class when no expected text is given, and says to pass --expect-text", async () => {
    const r = await testForm({ browser, pageUrl: `${server.url}/site/contact`, fields: GOOD });
    expect(r.status).toBe("ok");
    expect(r.notes.join(" ")).toContain("--expect-text");
  });

  it("reports unknown, not ok, when it submitted fine but cannot tell whether it worked", async () => {
    const r = await testForm({ browser, pageUrl: `${server.url}/site/contact-silent`, fields: GOOD });
    expect(r.status).toBe("unknown");
  });

  it("reports a server error when the submission gets a 500", async () => {
    const r = await testForm({ browser, pageUrl: `${server.url}/site/contact-broken`, fields: GOOD, expectText: "Thank you" });
    expect(r.status).toBe("server-error");
    expect(r.submissions[0]).toMatchObject({ method: "POST", url: "/site/contact-broken", status: 500 });
  });

  it("reports that nothing was sent when the browser's own validation blocks the submit, and shows its message", async () => {
    const r = await testForm({ browser, pageUrl: `${server.url}/site/contact-native`, fields: { name: "", email: "ada@example.com", message: "Hi" }, expectText: "Thank you" });
    expect(r.status).toBe("no-submission");
    expect(r.submissions).toEqual([]);
    expect(r.nativeValidationMessages.join(" ")).toContain("name:");
  });

  it("names the fields the form does not have and submits nothing", async () => {
    const before = server.contactSubmissions.length;
    const r = await testForm({ browser, pageUrl: `${server.url}/site/contact`, fields: { ...GOOD, phone: "123" } });
    expect(r.status).toBe("field-missing");
    expect(r.missingFields).toEqual(["phone"]);
    expect(r.submissions).toEqual([]);
    expect(server.contactSubmissions).toHaveLength(before);
  });

  it("reports page-error when the form page itself does not load", async () => {
    const r = await testForm({ browser, pageUrl: `${server.url}/site/does-not-exist`, fields: GOOD });
    expect(r.status).toBe("page-error");
  });

  it("honours robots.txt: refuses a disallowed form page and never requests it", async () => {
    const seen = server.requests.length;
    await expect(
      testForm({ browser, pageUrl: `${server.url}/site/contact`, fields: GOOD, robots: new RobotsChecker({ fetchImpl: fakeFetch("User-agent: *\nDisallow: /site/contact\n") }) }),
    ).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(server.requests.length).toBe(seen);
  });
});
