import { describe, expect, it } from "vitest";
import { parseCsv, readRecords, toCsv } from "../src/csv";

describe("csv", () => {
  it("reads quoted fields, doubled quotes, commas and newlines inside quotes", () => {
    const text = 'a,b\n"x, y","say ""hi"""\n"line1\nline2",z\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["line1\nline2", "z"],
    ]);
  });

  it("handles CRLF line endings, a BOM, and blank lines", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n\r\n3,4\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("turns rows into records keyed by the header, trimming and filling missing cells with empty strings", () => {
    const recs = readRecords("id, name ,plan\nr1, Ada ,pro\nr2,Grace\n");
    expect(recs).toEqual([
      { id: "r1", name: "Ada", plan: "pro" },
      { id: "r2", name: "Grace", plan: "" },
    ]);
  });

  it("writes CSV that reads back identically, quoting only where needed", () => {
    const rows = [
      { id: "1", name: 'He said "hi"', note: "a,b" },
      { id: "2", name: "plain", note: "" },
    ];
    const text = toCsv(["id", "name", "note"], rows);
    expect(text).toBe('id,name,note\n1,"He said ""hi""","a,b"\n2,plain,\n');
    expect(readRecords(text)).toEqual(rows);
  });
});
