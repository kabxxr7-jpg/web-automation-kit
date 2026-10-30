import { RobotsDisallowedError, RobotsUnavailableError } from "./robots";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Throw this for failures that will not get better by trying again (a 404, a bad argument). */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export interface RetryOptions {
  /** Retries AFTER the first attempt. 0 means try once. */
  retries: number;
  /** First backoff; doubles each retry. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function isRetryable(e: unknown): boolean {
  return !(e instanceof NonRetryableError || e instanceof RobotsDisallowedError || e instanceof RobotsUnavailableError);
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 250;
  const wait = opts.sleep ?? sleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      if (!isRetryable(e) || attempt === opts.retries) break;
      const delay = base * 2 ** attempt;
      opts.onRetry?.(e, attempt + 1, delay);
      await wait(delay);
    }
  }
  throw lastError;
}
