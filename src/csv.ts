/** Minimal CSV reader and writer: quoted fields, doubled quotes, commas and newlines inside quotes. */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully blank lines.
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** First line is the header; each later line becomes an object keyed by header name. */
export function readRecords(text: string): Record<string, string>[] {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return body.map((cells) => {
    const rec: Record<string, string> = {};
    names.forEach((n, i) => {
      rec[n] = (cells[i] ?? "").trim();
    });
    return rec;
  });
}

function cell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(cell).join(",")];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(","));
  return lines.join("\n") + "\n";
}
