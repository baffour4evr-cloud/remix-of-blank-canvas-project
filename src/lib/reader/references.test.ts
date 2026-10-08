import { describe, expect, it } from "vitest";

import type { ApparatusEntry } from "@/lib/reader/apparatus";
import { disjoinRanges } from "@/lib/reader/anchor";
import { buildReferences } from "@/lib/reader/references";
import { sentenceAt, sentenceRanges } from "@/lib/reader/sentences";
import type { Block, RefSystem, StructureNode } from "@/lib/reader/types";

// ---------------------------------------------------------------------------
// sentence segmentation
// ---------------------------------------------------------------------------

describe("sentence segmentation", () => {
  it("keeps abbreviations inside the sentence", () => {
    const t = "Dr. Mendelsohn cites cf. Od. 1.10 here. A second sentence follows.";
    const r = sentenceRanges(t);
    expect(r).toHaveLength(2);
    expect(t.slice(r[0]!.start, r[0]!.end).trim()).toBe("Dr. Mendelsohn cites cf. Od. 1.10 here.");
  });

  it("never returns an empty list for a fragment", () => {
    expect(sentenceRanges("no terminal punctuation")).toEqual([{ start: 0, end: 23 }]);
  });

  it("returns the whole sentence containing an offset, not a truncation", () => {
    const t = "First one. The marker sits right here, inside a long second sentence. Third.";
    const at = t.indexOf("here");
    const s = sentenceAt(t, at);
    expect(t.slice(s.start, s.end).trim()).toBe("The marker sits right here, inside a long second sentence.");
  });
});

// ---------------------------------------------------------------------------
// reference anchoring regression suite
// ---------------------------------------------------------------------------

const section = (id: string, over: Partial<StructureNode> = {}): StructureNode => ({
  id,
  type: "chapter",
  label: id,
  number: 1,
  title: "",
  page: 1,
  parent: null,
  depth: 1,
  start: 0,
  end: 99,
  ...over,
});

const block = (id: string, text: string, over: Partial<Block> = {}): Block => ({
  id,
  page: 1,
  type: "paragraph",
  section: "body",
  runs: [{ t: text }],
  text,
  ...over,
});

const system = (id: string, over: Partial<RefSystem> = {}): RefSystem => ({
  id,
  kind: "endnote",
  label: "Endnotes",
  grammar: "sequential",
  keyScope: "document",
  hosts: ["notes"],
  typography: { size: 9, indent: 0, leading: 11, altFontLemma: false },
  entryCount: 1,
  evidence: [],
  confidence: 0.9,
  samples: [],
  ...over,
});

const entry = (over: Partial<ApparatusEntry> & { blockId: string; key: string }): ApparatusEntry => ({
  system: "sys0",
  numeric: Number(over.key) || null,
  lemma: null,
  section: "notes",
  ...over,
});

describe("reference anchoring", () => {
  const structure = [section("body"), section("notes", { type: "apparatus" })];

  it("ignores a malformed legacy bibliography key instead of crashing", () => {
    const source = block("b1", "Darcy discusses Austen (1813) in passing.");
    const badEntry = { ...entry({ blockId: "n1", key: "Austen 1813" }), key: undefined } as unknown as ApparatusEntry;
    expect(() =>
      buildReferences(
        [source],
        structure,
        [system("sys0", { kind: "bibliography", grammar: "author-date" })],
        [badEntry],
      ),
    ).not.toThrow();
  });

  it("anchors an inline marker to its exact span and full sentence", () => {
    const src = block("b1", "Elizabeth was mortified.[3] She said nothing more that evening.");
    const note = block("n1", "3 Mortified: an eighteenth-century sense.", {
      section: "notes",
      type: "entry",
      key: "3",
    });
    const { refs } = buildReferences(
      [src, note],
      structure,
      [system("sys0")],
      [entry({ blockId: "n1", key: "3" })],
    );
    expect(refs).toHaveLength(1);
    const r = refs[0]!;
    expect(r.to).toBe("n1");
    expect(src.text.slice(r.marker.start, r.marker.end)).toBe("[3]");
    expect(src.text.slice(r.sentence.start, r.sentence.end).trim()).toBe("Elizabeth was mortified.[3]");
    expect(src.text.slice(r.paragraph.start, r.paragraph.end)).toBe(src.text);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it("resolves a line-keyed commentary entry onto the whole verse line", () => {
    const verse = block("v326", "Muse, tell me of the man of many turns", {
      type: "verse-line",
      line: 326,
    });
    const note = block("c1", "326 many turns — polytropos, the epithet.", {
      section: "notes",
      type: "entry",
      key: "326",
    });
    const { refs } = buildReferences(
      [verse, note],
      [
        section("body", { type: "book", number: 1 }),
        section("cbk1", { type: "book", number: 1 }),
        section("notes", { type: "apparatus", parent: "cbk1" }),
      ],
      [system("sysL", { grammar: "line-keyed", kind: "line-commentary", label: "Commentary" })],
      [entry({ blockId: "c1", key: "326", system: "sysL", numeric: 326, lemma: "many turns" })],
    );
    const r = refs.find((x) => x.type === "line-note");
    expect(r).toBeTruthy();
    expect(r!.to).toBe("c1");
    // anchors on the quoted expression, never the whole line
    expect(verse.text.slice(r!.marker.start, r!.marker.end)).toBe("many turns");
    expect(r!.sourceText).toBe("many turns");
    expect(r!.method).toBe("lemma-match");
    expect(r!.confidence).toBeGreaterThan(0.9);
  });

  it("keeps three lemma references in one line as three independent ranges", () => {
    const line = block("v1", "Tell me the tale of a man, Muse, who had so many roundabout ways", {
      type: "verse-line",
      line: 1,
    });
    const notes = [
      block("c1", "1 Tell me the tale: the proem opens.", { section: "notes", type: "entry", key: "1" }),
      block("c2", "1 Muse: the invocation.", { section: "notes", type: "entry", key: "1" }),
      block("c3", "1 roundabout ways: polytropos.", { section: "notes", type: "entry", key: "1" }),
    ];
    const { refs } = buildReferences(
      [line, ...notes],
      [
        section("body", { type: "book", number: 1 }),
        section("cbk1", { type: "book", number: 1 }),
        section("notes", { type: "apparatus", parent: "cbk1" }),
      ],
      [system("sysL", { grammar: "line-keyed", kind: "line-commentary", label: "Commentary" })],
      [
        entry({ blockId: "c1", key: "1", system: "sysL", numeric: 1, lemma: "Tell me the tale" }),
        entry({ blockId: "c2", key: "1", system: "sysL", numeric: 1, lemma: "Muse" }),
        entry({ blockId: "c3", key: "1", system: "sysL", numeric: 1, lemma: "roundabout ways" }),
      ],
    );
    const on = refs.filter((r) => r.marker.blockId === "v1");
    expect(on).toHaveLength(3);
    expect(on.map((r) => r.sourceText)).toEqual(["Tell me the tale", "Muse", "roundabout ways"]);
    expect(new Set(on.map((r) => r.to)).size).toBe(3);
    for (const r of on) expect(r.marker.end - r.marker.start).toBeLessThan(line.text.length);
    // disjoint
    const sorted = [...on].sort((a, b) => a.marker.start - b.marker.start);
    expect(sorted[0]!.marker.end).toBeLessThanOrEqual(sorted[1]!.marker.start);
    expect(sorted[1]!.marker.end).toBeLessThanOrEqual(sorted[2]!.marker.start);
  });


  it("records an unresolved edge instead of dropping the marker", () => {
    const src = block("b1", "A claim with a dangling note.[9]");
    const { refs, unresolved } = buildReferences([src], structure, [system("sys0")], []);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.to).toBeNull();
    expect(refs[0]!.method).toBe("unresolved");
    expect(unresolved).toHaveLength(1);
  });

  it("keeps every edge's marker inside its sentence and paragraph", () => {
    const src = block(
      "b1",
      "One sentence here.[1] A second sentence, longer than the first, follows it.[2] And a third.",
    );
    const { refs } = buildReferences(
      [src, block("n1", "1 first", { section: "notes", type: "entry", key: "1" }), block("n2", "2 second", { section: "notes", type: "entry", key: "2" })],
      structure,
      [system("sys0")],
      [entry({ blockId: "n1", key: "1" }), entry({ blockId: "n2", key: "2" })],
    );
    expect(refs).toHaveLength(2);
    for (const r of refs) {
      expect(r.marker.start).toBeGreaterThanOrEqual(r.sentence.start);
      expect(r.marker.end).toBeLessThanOrEqual(r.sentence.end);
      expect(r.sentence.start).toBeGreaterThanOrEqual(r.paragraph.start);
      expect(r.sentence.end).toBeLessThanOrEqual(r.paragraph.end);
    }
    expect(refs[0]!.sentence.end).toBeLessThanOrEqual(refs[1]!.sentence.start);
  });

  it("distinguishes a structural cross-reference from the structure itself", () => {
    const src = block("b1", "As we saw in Book 2, the suitors gather.");
    const { refs } = buildReferences(
      [src],
      [section("body"), section("bk2", { type: "book", number: 2, label: "Book 2" })],
      [],
      [],
    );
    const r = refs.find((x) => x.type === "structural-navigation");
    expect(r).toBeTruthy();
    expect(r!.toSection).toBe("bk2");
    expect(src.text.slice(r!.marker.start, r!.marker.end)).toContain("Book 2");
  });
});

// ---------------------------------------------------------------------------
// reference markers: the printed token, never the word beside it
// ---------------------------------------------------------------------------

describe("reference marker ranges", () => {
  const structure = [section("body"), section("notes", { type: "apparatus" })];
  const notes = [
    block("n6", "6 A note.", { section: "notes", type: "entry", key: "6" }),
    block("n7", "7 Another note.", { section: "notes", type: "entry", key: "7" }),
  ];
  const ents = [entry({ blockId: "n6", key: "6" }), entry({ blockId: "n7", key: "7" })];

  const run = (src: Block) => buildReferences([src, ...notes], structure, [system("sys0")], ents);

  it("anchors word[6] on the bracketed marker, not on the word", () => {
    const src = block("b1", "Elizabeth’s sense and conduct[6] impressed him.");
    const { refs } = run(src);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceText).toBe("[6]");
  });

  it("anchors word [6] on the marker alone", () => {
    const src = block("b1", "Elizabeth’s sense and conduct [6] impressed him.");
    const { refs } = run(src);
    expect(refs.map((r) => r.sourceText)).toEqual(["[6]"]);
  });

  it("anchors a bare superscript word6 on the number alone", () => {
    const src = block("b1", "Elizabeth’s sense and conduct6 impressed him.", {
      runs: [{ t: "Elizabeth’s sense and conduct" }, { t: "6", sup: true }, { t: " impressed him." }],
    });
    const { refs } = run(src);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceText).toBe("6");
    expect(src.text.slice(refs[0]!.marker.start, refs[0]!.marker.end)).toBe("6");
  });

  it("keeps two markers in one paragraph independent", () => {
    const src = block("b1", "A claim [6] and another claim [7] follow.");
    const { refs } = run(src);
    expect(refs.map((r) => r.sourceText)).toEqual(["[6]", "[7]"]);
    expect(refs.map((r) => r.to)).toEqual(["n6", "n7"]);
    expect(refs[0]!.marker.end).toBeLessThanOrEqual(refs[1]!.marker.start);
  });

  it("keeps a linked footnote number to the number itself", () => {
    const src = block("b1", "Elizabeth’s sense and conduct[6] impressed him.", {
      prov: { page: 1, pages: [1], boxes: [{ page: 1, x: 0, y: 700, w: 400, h: 12 }], lines: 1 },
    });
    const target = block("n6b", "6 A note.", {
      page: 2,
      section: "notes",
      type: "entry",
      key: "6",
      prov: { page: 2, pages: [2], boxes: [{ page: 2, x: 0, y: 500, w: 400, h: 12 }], lines: 1 },
    });
    const { refs } = buildReferences([src, target], structure, [], [], {
      links: [{ page: 1, x: 210, y: 700, w: 8, h: 10, destPage: 2, destY: 500, url: null, text: "6" }],
    });
    const link = refs.find((r) => r.provenance === "explicit-link");
    expect(link).toBeTruthy();
    expect(link!.sourceText).toBe("[6]");
    expect(link!.to).toBe("n6b");
  });

  it("keeps a genuinely phrasal link on its whole phrase", () => {
    const src = block("b1", "See the note on Elizabeth’s sense and conduct in the appendix.", {
      prov: { page: 1, pages: [1], boxes: [{ page: 1, x: 0, y: 700, w: 400, h: 12 }], lines: 1 },
    });
    const target = block("n9", "A long editorial discussion.", {
      page: 2,
      section: "notes",
      type: "entry",
      key: "9",
      prov: { page: 2, pages: [2], boxes: [{ page: 2, x: 0, y: 500, w: 400, h: 12 }], lines: 1 },
    });
    const { refs } = buildReferences([src, target], structure, [], [], {
      links: [
        {
          page: 1,
          x: 100,
          y: 700,
          w: 160,
          h: 10,
          destPage: 2,
          destY: 500,
          url: null,
          text: "Elizabeth’s sense and conduct",
        },
      ],
    });
    const link = refs.find((r) => r.provenance === "explicit-link");
    expect(link!.sourceText).toBe("Elizabeth’s sense and conduct");
  });

  it("does not widen a link onto the paragraph when its marker text is not found", () => {
    const src = block("b1", "A paragraph with no such marker in it at all.", {
      prov: { page: 1, pages: [1], boxes: [{ page: 1, x: 0, y: 700, w: 400, h: 12 }], lines: 1 },
    });
    const { refs } = buildReferences([src], structure, [], [], {
      links: [{ page: 1, x: 210, y: 700, w: 8, h: 10, destPage: null, url: null, text: "[42]" }],
    });
    expect(refs.filter((r) => r.provenance === "explicit-link")).toHaveLength(0);
  });
});

describe("overlap trimming", () => {
  it("never leaves a range inside a word", () => {
    const text = "And to make him call an Assembly of the long-haired Achaeans, daughter of Zeus, share the tale";
    const refs = [
      { from: "b1", marker: { start: 0, end: 60 }, confidence: 0.5 },
      { from: "b1", marker: { start: 1, end: 56 }, confidence: 0.9 },
    ];
    const out = disjoinRanges(refs, () => text);
    for (const r of out) {
      const s = text.slice(r.marker.start, r.marker.end);
      expect(s).toBe(s.trim());
      expect(/^[\p{L}\p{N}]/u.test(s)).toBe(true);
      if (r.marker.start > 0) expect(/[\p{L}\p{N}]/u.test(text[r.marker.start - 1]!)).toBe(false);
      if (r.marker.end < text.length) expect(/[\p{L}\p{N}]/u.test(text[r.marker.end]!)).toBe(false);
    }
  });
});
