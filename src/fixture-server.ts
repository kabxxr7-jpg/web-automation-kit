import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net, { type AddressInfo } from "node:net";

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
  /**
   * Links to OTHER origins that the small-business site under /site shows on its home page and on
   * /site/clean/. The default is one link to a port that nothing listens on, so a link checker has a
   * dead external link to find (a localhost port that was free at start-up).
   */
  externalLinks?: string[];
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

export interface ContactSubmission {
  name: string;
  email: string;
  message: string;
}

export interface FixtureServer {
  url: string;
  requests: RequestRecord[];
  submissions: Submission[];
  /** Messages accepted by /site/contact (the form that works). */
  contactSubmissions: ContactSubmission[];
  /** POSTs received by /site/contact-silent (the form that answers 200 and shows nothing). */
  silentSubmissions: number;
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


/** A localhost port that nothing is listening on right now (bind to a free one, then release it). */
export async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

function sitePage(title: string, body: string, headerLink = true): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body id="top">
<header>${headerLink ? '<a href="/site/">Harbor &amp; Pine Supply Co.</a>' : "Harbor &amp; Pine Supply Co."}</header>
${body}
</body></html>`;
}

function contactForm(
  action: string,
  values: { name?: string; email?: string; message?: string } = {},
  notice = "",
  native = false,
): string {
  return sitePage(
    "Contact us (fictional fixture)",
    `<h1>Contact us</h1>
${notice}
<form id="contact" method="post" action="${action}"${native ? "" : " novalidate"}>
  <label>Name <input name="name" type="text" value="${esc(values.name ?? "")}"${native ? " required" : ""}></label>
  <label>Email <input name="email" type="text" value="${esc(values.email ?? "")}"></label>
  <label>Message <textarea name="message">${esc(values.message ?? "")}</textarea></label>
  <button type="submit">Send message</button>
</form>
<p><a href="/site/">Home</a></p>`,
  );
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
  const contactSubmissions: ContactSubmission[] = [];
  let silentSubmissions = 0;
  const externalLinks = opts.externalLinks ?? [`http://127.0.0.1:${await closedPort()}/partner`];
  const externalHtml = externalLinks.map((href, i) => `<li><a href="${esc(href)}">Partner ${i + 1}</a></li>`).join("\n");

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

    // ---- a small fictional business site under /site, used by check-links and test-form ----
    if (u.pathname === "/site" || u.pathname === "/site/") {
      html(
        res,
        200,
        sitePage(
          "Harbor & Pine Supply Co.",
          `<h1>Harbor &amp; Pine Supply Co.</h1>
<nav><ul>
<li><a href="/site/about">About us</a></li>
<li><a href="/site/services">Our services</a></li>
<li><a href="/site/contact">Contact</a></li>
<li><a href="/site/shop">Shop</a></li>
<li><a href="/site/private/staff">Staff area</a></li>
<li><a href="mailto:hello@example.com">Email us</a></li>
<li><a href="tel:+10000000000">Call us</a></li>
<li><a href="#top">Back to top</a></li>
${externalHtml}
</ul></nav>`,
        ),
      );
      return;
    }
    if (u.pathname === "/site/about") {
      html(
        res,
        200,
        sitePage(
          "About us",
          `<h1>About us</h1>
<ul><li><a href="/site/">Home</a></li><li><a href="/site/services">Services</a></li>
<li><a href="/site/team">Meet the <b>team</b></a></li>
<li><a href="/site/chain/5">Archive</a></li>
<li><a href="/site/contact">Contact</a></li></ul>`,
        ),
      );
      return;
    }
    if (u.pathname === "/site/services") {
      html(
        res,
        200,
        sitePage(
          "Our services",
          `<h1>Our services</h1>
<ul><li><a href="/site/about">About</a></li>
<li><a href="/site/old-page">Our old price list</a></li>
<li><a href="/site/contact-silent">Request a quote</a></li>
<li><a href="/site/hang">Brochure (very slow)</a></li></ul>`,
        ),
      );
      return;
    }
    if (u.pathname === "/site/contact" && req.method === "GET") {
      html(res, 200, contactForm("/site/contact"));
      return;
    }
    if (u.pathname === "/site/contact" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const values = { name: (form.get("name") ?? "").trim(), email: (form.get("email") ?? "").trim(), message: (form.get("message") ?? "").trim() };
        let error = "";
        if (!values.name) error = "Name is required";
        else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) error = "Email address is not valid";
        else if (!values.message) error = "Message is required";
        if (error) {
          html(res, 422, contactForm("/site/contact", values, `<p class="error" role="alert">Error: ${esc(error)}</p>`));
          return;
        }
        contactSubmissions.push(values);
        html(
          res,
          200,
          sitePage(
            "Message sent",
            `<h1>Contact us</h1><div class="success">Thank you, ${esc(values.name)}. We will reply to ${esc(values.email)} within two days.</div>`,
          ),
        );
      });
      return;
    }
    if (u.pathname === "/site/contact-silent" && req.method === "GET") {
      html(res, 200, contactForm("/site/contact-silent"));
      return;
    }
    if (u.pathname === "/site/contact-silent" && req.method === "POST") {
      // The classic broken form: it answers 200 and shows the form again. No error, no thank-you.
      req.on("data", () => {});
      req.on("end", () => {
        silentSubmissions++;
        html(res, 200, contactForm("/site/contact-silent"));
      });
      return;
    }
    if (u.pathname === "/site/contact-native" && req.method === "GET") {
      // Uses the browser's own validation (the name field is required), so an empty name never reaches the server.
      html(res, 200, contactForm("/site/contact-native", {}, "", true));
      return;
    }
    if (u.pathname === "/site/contact-native" && req.method === "POST") {
      req.on("data", () => {});
      req.on("end", () => html(res, 200, sitePage("Message sent", `<div class="success">Thank you.</div>`)));
      return;
    }
    if (u.pathname === "/site/contact-broken" && req.method === "GET") {
      html(res, 200, contactForm("/site/contact-broken"));
      return;
    }
    if (u.pathname === "/site/contact-broken" && req.method === "POST") {
      req.on("data", () => {});
      req.on("end", () => html(res, 500, "<!doctype html><title>Error</title><h1>Internal Server Error</h1>"));
      return;
    }
    if (u.pathname === "/site/contact-soft" && req.method === "GET") {
      html(res, 200, contactForm("/site/contact-soft"));
      return;
    }
    if (u.pathname === "/site/contact-soft" && req.method === "POST") {
      // Shows an error message but answers 200, as many plugin forms do.
      req.on("data", () => {});
      req.on("end", () => html(res, 200, contactForm("/site/contact-soft", {}, `<p class="error" role="alert">Error: The message could not be sent. Please try again later.</p>`)));
      return;
    }
    if (u.pathname === "/site/shop") {
      res.writeHead(301, { location: "/site/services" });
      res.end();
      return;
    }
    if (u.pathname === "/site/old-page") {
      res.writeHead(301, { location: "/site/older-page" });
      res.end();
      return;
    }
    if (u.pathname === "/site/older-page") {
      res.writeHead(302, { location: "/site/new-page" });
      res.end();
      return;
    }
    if (u.pathname === "/site/new-page") {
      html(res, 200, sitePage("New price list", "<h1>Price list</h1><p><a href=\"/site/\">Home</a></p>"));
      return;
    }
    const chain = /^\/site\/chain\/(\d+)$/.exec(u.pathname);
    if (chain) {
      const n = Number(chain[1]);
      if (n > 0) {
        res.writeHead(302, { location: `/site/chain/${n - 1}` });
        res.end();
      } else {
        html(res, 200, sitePage("End of the chain", "<h1>End of the chain</h1>"));
      }
      return;
    }
    if (u.pathname === "/site/hang") {
      return; // never answers: a link that times out
    }
    if (u.pathname === "/site/private/staff") {
      html(res, 200, sitePage("Staff area", "<h1>Staff area</h1>"));
      return;
    }
    if (u.pathname === "/site/clean/" || u.pathname === "/site/clean") {
      html(res, 200, sitePage("A clean section", `<h1>A clean section</h1><ul><li><a href="/site/clean/a">Page A</a></li>\n${externalHtml}</ul>`, false));
      return;
    }
    if (u.pathname === "/site/clean/a") {
      html(res, 200, sitePage("Page A", `<h1>Page A</h1><p><a href="/site/clean/">Back</a></p>`, false));
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
    contactSubmissions,
    get silentSubmissions() {
      return silentSubmissions;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
