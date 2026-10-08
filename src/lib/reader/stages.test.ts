import { describe, expect, it } from "vitest";
import { analyze } from "./pipeline";
import type { RawDoc, RawItem } from "./types";

function page(n: number, items: RawItem[]) {
  return { page: n, width: 600, height: 800, items, links: [] };
}
function line(y: number, t: string, x = 60, s = 12): RawItem {
  return { x, y, w: t.length * 5, s, f: "F1", t };
}

/** A perfectly ordinary novel: prose, chapter headings, no apparatus at all. */
function plainBook(pages = 30): RawDoc {
  const body = Array.from({ length: 30 }, (_, i) =>
    line(700 - i * 20, "It was a quiet morning and the street outside was already full of noise and hurry."),
  );
  return {
    pageCount: pages,
    meta: { title: "A Plain Novel" },
    outline: [],
    pages: Array.from({ length: pages }, (_, i) =>
      i % 10 === 0
        ? page(i + 1, [line(740, `Chapter ${i / 10 + 1}`, 60, 18), ...body.slice(0, 20)])
        : page(i + 1, body),
    ),
  };
}

describe("generic pipeline diagnostics", () => {
  it("reports every stage for a book with no reference system, and still imports it", () => {
    const m = analyze(plainBook(), "plain");
    const ids = m.diagnostics.stages.map((s) => s.id);
    expect(ids).toEqual([
      "extraction",
      "font-unicode",
      "geometry",
      "reading-order",
      "structure",
      "text-normalization",
      "reference-extraction",
      "reference-classification",
      "reference-resolution",
      "artifact",
    ]);
    expect(m.blocks.length).toBeGreaterThan(0);
    expect(m.diagnostics.issues.some((i) => i.code === "ocr-required")).toBe(false);
    expect(m.diagnostics.readiness).not.toBe("unreadable");
  });

  it("flags a page-image PDF as OCR-required instead of pretending it parsed", () => {
    const raw: RawDoc = {
      pageCount: 200,
      meta: {},
      outline: [],
      pages: Array.from({ length: 200 }, (_, i) => page(i + 1, i === 0 ? [line(700, "scanned by someone")] : [])),
    };
    const m = analyze(raw, "scan");
    expect(m.diagnostics.readiness).toBe("unreadable");
    const codes = m.diagnostics.issues.map((i) => i.code);
    expect(codes).toContain("ocr-required");
    expect(m.diagnostics.stages.find((s) => s.id === "reference-resolution")!.status).toBe("skipped");
  });

  it("does not crash on an empty document", () => {
    const raw: RawDoc = { pageCount: 0, meta: {}, outline: [], pages: [] };
    const m = analyze(raw, "empty");
    expect(m.diagnostics.issues.some((i) => i.code === "extraction-failure")).toBe(true);
  });
});
