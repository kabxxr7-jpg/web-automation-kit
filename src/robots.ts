/**
 * A small robots.txt reader. It covers the common cases (User-agent groups, Allow, Disallow,
 * longest match wins, `*` wildcards, `$` end anchor). It is not a full RFC 9309 implementation:
 * it ignores Crawl-delay and Sitemap lines, and it does not handle percent-encoding edge cases.
 */

export const DEFAULT_USER_AGENT = "web-automation-kit";

export class RobotsDisallowedError extends Error {
  constructor(
    public readonly url: string,
    public readonly rule: string,
  ) {
    super(`robots.txt disallows ${url} (${rule}). Not fetched.`);
    this.name = "RobotsDisallowedError";
  }
}

export class RobotsUnavailableError extends Error {
  constructor(
    public readonly origin: string,
    detail: string,
  ) {
    super(`Could not read robots.txt for ${origin} (${detail}). Not fetched, because the rules are unknown.`);
    this.name = "RobotsUnavailableError";
  }
}

interface Rule {
  type: "allow" | "disallow";
  pattern: string;
}

export interface RobotsRules {
  rules: Rule[];
}

export function parseRobots(text: string, agentToken: string = DEFAULT_USER_AGENT): RobotsRules {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (!current || value === "") continue; // an empty Disallow means "allow everything"
      current.rules.push({ type: field, pattern: value });
    } else {
      lastWasAgent = false;
    }
  }

  const token = agentToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.includes(token));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  return { rules: chosen.flatMap((g) => g.rules) };
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function matches(pattern: string, target: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map(escapeRegex).join(".*") + (anchored ? "$" : ""));
  return re.test(target);
}

export function evaluate(rules: RobotsRules, pathAndQuery: string): { allowed: boolean; rule?: string } {
  let best: { len: number; rule: Rule } | null = null;
  for (const rule of rules.rules) {
    if (!matches(rule.pattern, pathAndQuery)) continue;
    const len = rule.pattern.length;
    // Longest match wins; on a tie, Allow beats Disallow.
    if (!best || len > best.len || (len === best.len && rule.type === "allow")) best = { len, rule };
  }
  if (!best) return { allowed: true };
  const label = `${best.rule.type === "allow" ? "Allow" : "Disallow"}: ${best.rule.pattern}`;
  return { allowed: best.rule.type === "allow", rule: label };
}

export interface RobotsCheckerOptions {
  userAgent?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Fetches and caches robots.txt per origin, then answers allowed or not for each URL. */
export class RobotsChecker {
  private readonly cache = new Map<string, Promise<RobotsRules>>();
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: RobotsCheckerOptions = {}) {
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  private load(origin: string): Promise<RobotsRules> {
    let p = this.cache.get(origin);
    if (!p) {
      p = this.fetchRules(origin);
      this.cache.set(origin, p);
    }
    return p;
  }

  private async fetchRules(origin: string): Promise<RobotsRules> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${origin}/robots.txt`, {
        headers: { "user-agent": this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new RobotsUnavailableError(origin, e instanceof Error ? e.message : String(e));
    }
    if (res.status >= 500) throw new RobotsUnavailableError(origin, `HTTP ${res.status}`);
    if (res.status >= 400) return { rules: [] }; // no robots.txt published: nothing is disallowed
    return parseRobots(await res.text(), this.userAgent);
  }

  async check(url: string): Promise<{ allowed: boolean; rule?: string }> {
    const u = new URL(url);
    const rules = await this.load(u.origin);
    return evaluate(rules, u.pathname + u.search);
  }

  /** Throws RobotsDisallowedError before anything is requested from the page itself. */
  async assertAllowed(url: string): Promise<void> {
    const r = await this.check(url);
    if (!r.allowed) throw new RobotsDisallowedError(url, r.rule ?? "Disallow");
  }
}
