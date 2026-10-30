import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

/**
 * A tiny fictional site, served from `fixtures/`, so every example and test runs against something
 * that is ours. Nothing here talks to the internet.
 */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

export interface FixtureOptions {
  port?: number;
  pageSize?: number;
  /** { 3: 1 } means: the first request for product page 3 answers 503, then it works. */
  flakyPages?: Record<number, number>;
  /** How long /api/slow-data takes to answer. */
  dataDelayMs?: number;
}

export interface RequestRecord {
  method: string;
  url: string;
  at: number;
}

export interface Submission {
  id: number;
  name: string;
  email: string;
  plan: string;
  newsletter: boolean;
}

export interface FixtureServer {
  url: string;
  requests: RequestRecord[];
  submissions: Submission[];
  close(): Promise<void>;
}

interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  stock: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

export async function startFixtureServer(opts: FixtureOptions = {}): Promise<FixtureServer> {
  const products = JSON.parse(await readFile(path.join(FIXTURES, "products.json"), "utf8")) as Product[];
  const formHtml = await readFile(path.join(FIXTURES, "form.html"), "utf8");
  const delayedHtml = await readFile(path.join(FIXTURES, "delayed.html"), "utf8");
  const robotsTxt = await readFile(path.join(FIXTURES, "robots.txt"), "utf8");

  const pageSize = opts.pageSize ?? 5;
  const totalPages = Math.ceil(products.length / pageSize);
  const flaky: Record<number, number> = { ...(opts.flakyPages ?? {}) };
  const requests: RequestRecord[] = [];
  const submissions: Submission[] = [];

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://fixture.local");
    requests.push({ method: req.method ?? "GET", url: u.pathname + u.search, at: Date.now() });

    if (u.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(robotsTxt);
      return;
    }

    if (u.pathname === "/") {
      html(
        res,
        200,
        `<!doctype html><meta charset="utf-8"><title>Fixture site</title><h1>Fictional fixture site</h1>
<ul><li><a href="/products">Products</a></li><li><a href="/form">Sign-up form</a></li>
<li><a href="/delayed">Weekly report</a></li><li><a href="/private/report">Private report</a></li></ul>`,
      );
      return;
    }

    if (u.pathname === "/products") {
      const page = Number(u.searchParams.get("page") ?? "1");
      if (!Number.isInteger(page) || page < 1 || page > totalPages) {
        html(res, 404, "<!doctype html><title>Not found</title><h1>No such page</h1>");
        return;
      }
      const remaining = flaky[page] ?? 0;
      if (remaining > 0) {
        flaky[page] = remaining - 1;
        html(res, 503, "<!doctype html><title>Unavailable</title><h1>Temporarily unavailable</h1>");
        return;
      }
      const slice = products.slice((page - 1) * pageSize, page * pageSize);
      const items = slice
        .map(
          (p) =>
            `<li class="product" data-id="${esc(p.id)}"><span class="name">${esc(p.name)}</span> ` +
            `<span class="price">${p.price.toFixed(2)}</span> <span class="category">${esc(p.category)}</span> ` +
            `<span class="stock">${p.stock}</span></li>`,
        )
        .join("\n");
      const next = page < totalPages ? `<a rel="next" href="/products?page=${page + 1}">Next</a>` : "";
      const prev = page > 1 ? `<a rel="prev" href="/products?page=${page - 1}">Previous</a>` : "";
      html(
        res,
        200,
        `<!doctype html><meta charset="utf-8"><title>Products, page ${page}</title>
<main><h1>Products</h1><ul data-testid="product-list">
${items}
</ul><nav>${prev} <span>Page ${page} of ${totalPages}</span> ${next}</nav></main>`,
      );
      return;
    }

    if (u.pathname === "/form" && req.method === "GET") {
      html(res, 200, formHtml);
      return;
    }

    if (u.pathname === "/submit" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const name = (form.get("name") ?? "").trim();
        const email = (form.get("email") ?? "").trim();
        const plan = form.get("plan") ?? "";
        let error = "";
        if (!name) error = "Name is required";
        else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) error = "Email address is not valid";
        else if (!["basic", "pro", "team"].includes(plan)) error = "Plan must be basic, pro or team";

        if (error) {
          html(
            res,
            422,
            `<!doctype html><meta charset="utf-8"><title>Error</title><div data-testid="result" data-status="error">Error: ${esc(error)}</div>`,
          );
          return;
        }
        const sub: Submission = { id: submissions.length + 1, name, email, plan, newsletter: form.get("newsletter") === "on" };
        submissions.push(sub);
        html(
          res,
          200,
          `<!doctype html><meta charset="utf-8"><title>Saved</title><div data-testid="result" data-status="ok">Saved submission #${sub.id} for ${esc(name)}</div>`,
        );
      });
      return;
    }

    if (u.pathname === "/delayed") {
      html(res, 200, delayedHtml);
      return;
    }

    if (u.pathname === "/api/slow-data") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            { id: "orders", label: "Orders", value: "128" },
            { id: "returns", label: "Returns", value: "7" },
            { id: "refunds", label: "Refunds", value: "3" },
          ]),
        );
      }, opts.dataDelayMs ?? 700);
      return;
    }

    if (u.pathname.startsWith("/private/")) {
      html(res, 200, "<!doctype html><meta charset=\"utf-8\"><title>Private</title><h1>Private report</h1><p>Internal figures.</p>");
      return;
    }

    html(res, 404, "<!doctype html><title>Not found</title><h1>Not found</h1>");
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    submissions,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
