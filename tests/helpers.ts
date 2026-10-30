import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "wak-"));
}

export async function removeTmp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** A fetch() stand-in that serves a fixed robots.txt (or a status) for any URL. */
export function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}
