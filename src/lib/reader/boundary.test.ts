// Regression tests for the extraction -> semantic-interpretation boundary.
//
// They assert two things only: that semantic classification never destroys or
// rewrites the extracted characters, and that every semantic node can still say
// which source spans produced it.

import { describe, expect, it } from "vitest";

import { analyze } from "./pipeline";
import type { RawDoc, RawItem, RawPage } from "./types";

interface Span {
  t: string;
  /** font id; a different id is a different face, not a semantic instruction */
  f?: string;
  s?: number;
  x?: number;
  /** baseline offset, used to place a superscript above the line */
  dy?: number;
}

const SIZE = 10;
const LEFT = 100;

/** Build a page whose lines are laid out top to bottom at a fixed leading. */
function page(n: number, lines: Span[][]): RawPage {
  const items: RawItem[] = [];
  let o = 0;
  lines.forEach((spans, i) => {
    const y = 700 - i * 14;
    let x = spans[0]?.x ?? LEFT;
    for (const sp of spans) {
      const s = sp.s ?? SIZE;
      const t = sp.t;
      const w = t.length * s * 0.5;
      items.push({
        x: sp.x ?? x,
        y: y + (sp.dy ?? 0),
        w,
        s,
        f: sp.f ?? "roman",
        t,
        t0: t,
        o: o++,
        h: s,
      });
      x = (sp.x ?? x) + w;
    }
  });
  return { page: n, width: 612, height: 792, items, links: [], method: "native" };
}

function doc(pages: RawPage[]): RawDoc {
  return { pageCount: pages.length, meta: {}, outline: [], pages };
}

const PROSE = (k: number): Span[][] =>
  Array.from({ length: k }, (_, i) => [
    {
      t: `Ordinary running prose fills the measure completely on line ${i} of this paragraph and continues`,
    },
  ]);

describe("extraction / semantics boundary", () => {
  const model = analyze(
    doc([
      page(1, [
        ...PROSE(6),
        [{ t: "JANE AUSTEN was born in 1775 and wrote of ordinary life in the country", s: SIZE }],
        [{ t: "Alkínoös ḯ naïve cœur — final office flight, set with accents and ligatures" }],
        [{ t: "a phrase in roman and " }, { t: "a phrase in italic", f: "italic" }, { t: " and roman again" }],
        [{ t: "when tea was over" }, { t: "[6]", s: 6, dy: 4 }, { t: " the party went in to cards" }],
        ...PROSE(6),
      ]),
      page(2, [
        ...PROSE(4),
        [{ t: "the quoted passage opens here and is set in a smaller face throughout", s: 8, x: 120 }],
        [{ t: "and the quotation continues over a second line before prose resumes", s: 8, x: 120 }],
        [{ t: "and closes on a third line of the same smaller measure entirely", s: 8, x: 120 }],
        [{ t: "a second quoted paragraph opens with its own indent inside the same passage", s: 8, x: 132 }],
        [{ t: "and runs on to the end of the quotation before ordinary prose resumes", s: 8, x: 120 }],
        ...PROSE(4),
      ]),
    ]),
    "t1",
  );

  const all = model.blocks.map((b) => b.text).join("\n");

  it("keeps uppercase text exactly as extracted", () => {
    expect(all).toContain("JANE AUSTEN was born in 1775");
  });

  it("keeps accented characters, combining marks and ligature expansions", () => {
    expect(all).toContain("Alkínoös ḯ naïve cœur");
    expect(all).toContain("final office flight");
  });

  it("records a second face as emphasis without altering its characters", () => {
    const b = model.blocks.find((x) => x.text.includes("a phrase in italic"))!;
    expect(b).toBeDefined();
    const em = b.runs.filter((r) => r.em).map((r) => r.t).join("");
    expect(em).toContain("a phrase in italic");
    expect(b.runs.map((r) => r.t).join("")).toContain("a phrase in roman and a phrase in italic");
  });

  it("keeps a reference marker as its own run, distinct from the phrase before it", () => {
    const b = model.blocks.find((x) => x.text.includes("when tea was over"))!;
    const marker = b.runs.find((r) => r.sup);
    expect(marker?.t.trim()).toBe("[6]");
    expect(b.text).toContain("when tea was over");
    // the exact character range of the marker is addressable in the block text
    const at = b.text.indexOf("[6]");
    expect(at).toBeGreaterThan(0);
    expect(b.text.slice(at, at + 3)).toBe("[6]");
  });

  it("reads a smaller-font passage as a quotation without losing a character", () => {
    const quoted = model.blocks.filter((b) => b.text.includes("the quoted passage opens here"));
    expect(quoted).toHaveLength(1);
    expect(quoted[0]!.type).toBe("blockquote");
    expect(all).toContain("and closes on a third line of the same smaller measure entirely");
  });

  it("never marks a whole smaller-font passage as superscript", () => {
    const quoted = model.blocks.find((b) => b.text.includes("the quoted passage opens here"))!;
    expect(quoted.runs.some((r) => r.sup)).toBe(false);
  });

  it("gives every node provenance back to its source page and spans", () => {
    for (const b of model.blocks) {
      expect(b.prov?.page).toBeGreaterThan(0);
      expect(b.prov?.boxes.length).toBeGreaterThan(0);
      expect(b.prov?.sources?.length).toBeGreaterThan(0);
    }
  });

  it("does not invent structure from prominent-looking prose", () => {
    expect(model.structure.filter((s) => s.type !== "root")).toHaveLength(0);
    expect(model.blocks.some((b) => b.type === "heading")).toBe(false);
  });
});

describe("structure needs document evidence", () => {
  it("accepts a repeated, numbered division heading as structure", () => {
    const chapter = (n: number, label: string): Span[][] => [
      [{ t: label, s: 16, x: 250 }],
      ...PROSE(8),
    ];
    const model = analyze(
      doc([page(1, chapter(1, "Chapter I")), page(2, chapter(2, "Chapter II")), page(3, chapter(3, "Chapter III"))]),
      "t2",
    );
    const nodes = model.structure.filter((s) => s.type !== "root");
    expect(nodes.map((n) => n.number)).toEqual([1, 2, 3]);
    expect(nodes.every((n) => n.type === "chapter")).toBe(true);
    // the printed wording itself survives in the heading nodes
    expect(model.blocks.filter((b) => b.type === "heading").map((b) => b.text)).toEqual([
      "Chapter I",
      "Chapter II",
      "Chapter III",
    ]);
    expect(model.blocks.filter((b) => b.type === "heading")).toHaveLength(3);
  });
});
