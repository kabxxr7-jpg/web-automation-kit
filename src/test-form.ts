import type { Locator, Page } from "playwright-core";
import { kitUserAgent, type CommonOptions } from "./browser";
import { RobotsChecker } from "./robots";

/**
 * Submits ONE contact-style form once and reports what really happened: did the success text appear, did a
 * visible error appear, and what did the server answer. It sends a real submission (a real site may send an
 * email), so it refuses any host that is not localhost unless the caller says "I own this site".
 */

export class RemoteHostRefusedError extends Error {
  constructor(public readonly host: string) {
    super(
      `Refusing to submit a form on ${host}. test-form only runs against localhost unless you pass --i-own-this-site, ` +
        `to confirm that you own this site or are authorised to test it. It sends a real submission, and a real site may send an email.`,
    );
    this.name = "RemoteHostRefusedError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertTestableHost(url: string, iOwnThisSite: boolean): void {
  const host = new URL(url).hostname.toLowerCase();
  const local = LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
  if (!local && !iOwnThisSite) throw new RemoteHostRefusedError(host);
}

export type FormStatus =
  | "ok" //               the expected text (or a recognised success message) appeared and no error was shown
  | "validation-error" // the page showed an error, or the server rejected the data (4xx)
  | "silent-failure" //   the server answered normally but neither the expected text nor any error appeared
  | "server-error" //     the submission got a 5xx answer or the request failed
  | "no-submission" //    clicking submit sent nothing (for example the browser's own validation stopped it)
  | "field-missing" //    the form has no field with a name you asked for, so nothing was submitted
  | "page-error" //       the form page itself did not load
  | "unknown"; //         submitted fine, but you gave no --expect-text and no success message was recognised

export interface SubmissionSeen {
  method: string;
  url: string;
  status: number | null;
  failure?: string;
}

export interface TestFormOptions extends CommonOptions {
  pageUrl: string;
  /** Field name attribute to value. A select takes a value or a label; a checkbox takes true/false/yes/no/on/off/1/0. */
  fields: Record<string, string>;
  /** Text that proves success, matched case-insensitively against the visible text of the page after the submit. */
  expectText?: string;
  /** CSS selector of the form. Default: the first form that contains every field name. */
  formSelector?: string;
  iOwnThisSite?: boolean;
  robots?: RobotsChecker;
}

export interface TestFormResult {
  pageUrl: string;
  finalUrl: string;
  pageTitle: string;
  status: FormStatus;
  expectText?: string;
  expectTextFound: boolean | null;
  visibleErrors: string[];
  nativeValidationMessages: string[];
  submissions: SubmissionSeen[];
  missingFields: string[];
  notes: string[];
}

const ERROR_SELECTORS = [
  '[role="alert"]',
  ".error",
  ".errors",
  ".field-error",
  ".form-error",
  ".invalid-feedback",
  ".wpcf7-not-valid-tip",
  ".wpcf7-validation-errors",
  ".wpcf7-response-output.wpcf7-validation-errors",
  ".elementor-message-danger",
  '[data-status="error"]',
].join(",");

const SUCCESS_SELECTORS = [".success", ".wpcf7-mail-sent-ok", ".elementor-message-success", '[data-status="ok"]'].join(",");

const truthy = (v: string): boolean => /^(1|y|yes|true|on|x|checked)$/i.test(v.trim());
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const firstLine = (e: unknown): string => ((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "").trim();

/** Parses `a=1,b=2` (a literal comma is written `\,`) and repeated `--field a=1` values into one object. */
export function parseFields(specs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const parts: string[] = [];
    let cur = "";
    for (let i = 0; i < spec.length; i++) {
      if (spec[i] === "\\" && spec[i + 1] === ",") {
        cur += ",";
        i++;
      } else if (spec[i] === ",") {
        parts.push(cur);
        cur = "";
      } else cur += spec[i];
    }
    parts.push(cur);
    for (const part of parts) {
      if (part === "") continue;
      const eq = part.indexOf("=");
      if (eq <= 0) throw new Error(`Expected name=value, got "${part}"`);
      out[part.slice(0, eq).trim()] = part.slice(eq + 1);
    }
  }
  return out;
}

async function pickForm(page: Page, names: string[], selector?: string): Promise<{ form: Locator; missing: string[] } | null> {
  if (selector) {
    const form = page.locator(selector).first();
    if ((await form.count()) === 0) return null;
    const missing = await form.evaluate((f, ns) => ns.filter((n) => !f.querySelector(`[name="${n.replace(/"/g, '\\"')}"]`)), names);
    return { form, missing };
  }
  const best = await page.evaluate((ns) => {
    let index = -1;
    let bestMissing = ns.length + 1;
    document.querySelectorAll("form").forEach((f, i) => {
      const missing = ns.filter((n) => !f.querySelector(`[name="${n.replace(/"/g, '\\"')}"]`)).length;
      if (missing < bestMissing) {
        bestMissing = missing;
        index = i;
      }
    });
    return { index, bestMissing };
  }, names);
  if (best.index < 0 || best.bestMissing >= names.length) return null; // no form has even one of the fields
  const form = page.locator("form").nth(best.index);
  const missing = await form.evaluate((f, ns) => ns.filter((n) => !f.querySelector(`[name="${n.replace(/"/g, '\\"')}"]`)), names);
  return { form, missing };
}

export async function testForm(opts: TestFormOptions): Promise<TestFormResult> {
  assertTestableHost(opts.pageUrl, opts.iOwnThisSite ?? false);
  const robots = opts.robots ?? new RobotsChecker();
  await robots.assertAllowed(opts.pageUrl);

  const names = Object.keys(opts.fields);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const result: TestFormResult = {
    pageUrl: opts.pageUrl,
    finalUrl: opts.pageUrl,
    pageTitle: "",
    status: "unknown",
    expectText: opts.expectText,
    expectTextFound: opts.expectText ? false : null,
    visibleErrors: [],
    nativeValidationMessages: [],
    submissions: [],
    missingFields: [],
    notes: [],
  };

  const context = await opts.browser.newContext({ userAgent: opts.userAgent ?? kitUserAgent() });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  const submissions: SubmissionSeen[] = [];
  let recording = false;
  const isSubmission = (method: string): boolean => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  page.on("response", (res) => {
    const req = res.request();
    if (recording && isSubmission(req.method())) submissions.push({ method: req.method(), url: new URL(req.url()).pathname, status: res.status() });
  });
  page.on("requestfailed", (req) => {
    if (recording && isSubmission(req.method())) submissions.push({ method: req.method(), url: new URL(req.url()).pathname, status: null, failure: req.failure()?.errorText ?? "request failed" });
  });

  try {
    const loaded = await page.goto(opts.pageUrl, { waitUntil: "domcontentloaded" });
    if (!loaded || loaded.status() >= 400) {
      result.status = "page-error";
      result.notes.push(`The form page answered HTTP ${loaded?.status() ?? "no response"}.`);
      return result;
    }

    const picked = await pickForm(page, names, opts.formSelector);
    if (!picked) {
      result.status = "field-missing";
      result.missingFields = names;
      result.notes.push(opts.formSelector ? `No element matches ${opts.formSelector}.` : "No form on the page contains any of the field names you gave.");
      return result;
    }
    const { form, missing } = picked;
    if (missing.length > 0) {
      result.status = "field-missing";
      result.missingFields = missing;
      result.notes.push(`The form has no field named: ${missing.join(", ")}. Nothing was submitted.`);
      return result;
    }

    for (const [name, value] of Object.entries(opts.fields)) {
      const selector = `[name="${name.replace(/"/g, '\\"')}"]`;
      const field = form.locator(selector).first();
      const kind = await field.evaluate((el) => `${el.tagName.toLowerCase()}:${(el as HTMLInputElement).type ?? ""}`);
      try {
        if (kind.startsWith("select")) {
          await field.selectOption(value).catch(async () => field.selectOption({ label: value }));
        } else if (kind.endsWith(":checkbox")) {
          await field.setChecked(truthy(value));
        } else if (kind.endsWith(":radio")) {
          await form.locator(`${selector}[value="${value.replace(/"/g, '\\"')}"]`).first().check();
        } else {
          await field.fill(value);
        }
      } catch (e) {
        result.status = "field-missing";
        result.missingFields.push(name);
        result.notes.push(`Could not fill "${name}": ${firstLine(e)}`);
        return result;
      }
    }

    const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
    const submitFound = (await submit.count()) > 0;
    recording = true;
    const navigation = page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout: 1500 }).catch(() => null);
    const response = page.waitForResponse((r) => isSubmission(r.request().method()), { timeout: Math.min(timeoutMs, 6000) }).catch(() => null);
    if (submitFound) await submit.click();
    else await form.evaluate((f) => (f as HTMLFormElement).requestSubmit());
    const seen = await response;
    await navigation;
    await page.waitForLoadState("load").catch(() => undefined);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    recording = false;

    result.submissions = submissions;
    result.finalUrl = page.url();
    result.pageTitle = await page.title();

    const text = squash(await page.evaluate(() => document.body?.innerText ?? ""));
    if (opts.expectText) result.expectTextFound = text.toLowerCase().includes(squash(opts.expectText).toLowerCase());

    // Browser-side code. It avoids named inner functions on purpose: some bundlers wrap those in a helper
    // that does not exist inside the page.
    const found = await page.evaluate(
      ({ errorSel, successSel, expect }) => {
        const errorEls = [...document.querySelectorAll(errorSel)].filter((el) => {
          const st = getComputedStyle(el);
          return st.display !== "none" && st.visibility !== "hidden" && (el as HTMLElement).offsetParent !== null;
        });
        const successEls = [...document.querySelectorAll(successSel)].filter((el) => {
          const st = getComputedStyle(el);
          return st.display !== "none" && st.visibility !== "hidden" && (el as HTMLElement).offsetParent !== null;
        });
        const errors: string[] = [];
        for (const el of errorEls) {
          if (el.matches(successSel) || el.closest(successSel)) continue; // some plugins give a success message role="alert"
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          if (!text) continue;
          if (expect && text.toLowerCase().includes(expect.toLowerCase())) continue;
          if (!errors.includes(text)) errors.push(text);
        }
        const success = successEls.map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()).filter((x) => x !== "");
        const native: string[] = [];
        document.querySelectorAll(":invalid").forEach((el) => {
          const input = el as HTMLInputElement;
          if (input.validationMessage) native.push(`${input.name || input.id || input.tagName.toLowerCase()}: ${input.validationMessage}`);
        });
        return { errors, success, native };
      },
      { errorSel: ERROR_SELECTORS, successSel: SUCCESS_SELECTORS, expect: opts.expectText ?? "" },
    );
    result.visibleErrors = found.errors;
    result.nativeValidationMessages = found.native;

    // ---- decide ----
    const last = submissions[submissions.length - 1];
    if (!seen || submissions.length === 0) {
      result.status = "no-submission";
      result.notes.push(
        found.native.length > 0
          ? "Clicking submit sent no request. The browser's own validation blocked it (see nativeValidationMessages)."
          : "Clicking submit sent no request. A script on the page may have stopped it, or the button is not wired up.",
      );
    } else if (submissions.some((s) => s.status === null || (s.status ?? 0) >= 500)) {
      result.status = "server-error";
      result.notes.push(`The submission failed: ${submissions.map((s) => `${s.method} ${s.url} -> ${s.status ?? s.failure}`).join(", ")}.`);
    } else if (found.errors.length > 0) {
      result.status = "validation-error";
    } else if (opts.expectText) {
      if (result.expectTextFound) result.status = "ok";
      else if ((last?.status ?? 0) >= 400) {
        result.status = "validation-error";
        result.notes.push(`The server rejected the submission (HTTP ${last?.status}) but the page shows no visible message.`);
      } else {
        result.status = "silent-failure";
        result.notes.push(`The server answered HTTP ${last?.status} but "${opts.expectText}" never appeared and no error was shown. Nothing visible says whether the message was received.`);
      }
    } else if (found.success.length > 0) {
      result.status = "ok";
      result.notes.push(`Success message recognised by its class: "${found.success[0]}". Pass --expect-text to be explicit.`);
    } else if ((last?.status ?? 0) >= 400) {
      result.status = "validation-error";
      result.notes.push(`The server rejected the submission (HTTP ${last?.status}) but the page shows no visible message.`);
    } else {
      result.status = "unknown";
      result.notes.push("The submission went through but no success message was recognised. Pass --expect-text with the text a visitor sees.");
    }
    return result;
  } finally {
    await context.close();
  }
}
