import { chromium, type Browser } from "playwright-core";
import { DEFAULT_USER_AGENT } from "./robots";

export interface LaunchOptions {
  headless?: boolean;
}

/** Uses the Google Chrome already installed on the machine; no browser download is needed. */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome", headless: opts.headless ?? true });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw new Error(`Could not start Google Chrome (${msg}). Install Chrome, or change launchBrowser() to point at another browser.`);
  }
}

/** The kit identifies itself honestly in the User-Agent. It does not pretend to be a person's browser. */
export function kitUserAgent(token: string = DEFAULT_USER_AGENT): string {
  return `${token}/0.1 (+local automation demo)`;
}

export interface CommonOptions {
  browser: Browser;
  /** Milliseconds to wait between page requests. Polite default. */
  delayMs?: number;
  /** Per-step timeout for waiting on the page. */
  timeoutMs?: number;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
}
