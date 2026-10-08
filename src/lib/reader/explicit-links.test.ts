import { describe, expect, it } from "vitest";

import { buildReferences, type PageLink } from "@/lib/reader/references";
import { toReaderBlock } from "@/lib/reader/inline";
import type { Block, Provenance, RefEdge, StructureNode } from "@/lib/reader/types";

// ---------------------------------------------------------------------------
// Explicitly linked internal references.
//
// These tests are generic: no document, title or phrase is special-cased. They
// assert one contract — when the file's own link annotation states which
// characters are linked, the reference covers exactly those characters and
// nothing else, and its destination content is reachable from the persisted
// model without any further parsing.
// ---------------------------------------------------------------------------

const structure: StructureNode[] = [
  {
    id: "body",
    type: "chapter",
    label: "body",
    number: 1,
    title: "",
    page: 1,
    parent: null,
    depth: 1,
    start: 0,
    end: 99,
  },
  {
    id: "notes",
    type: "apparatus",
    label: "Notes",
    number: null,
    title: "Notes",
    page: 2,
    parent: null,
    depth: 1,
    start: 0,
    end: 99,
  },
];

const box = (page: number, y = 700): Provenance => ({
  page,
  pages: [page],
  boxes: [{ page, x: 0, y, w: 400, h: 12 }],
  lines: 1,
});

const block = (id: string, text: string, over: Partial<Block> = {}): Block => ({
  id,
  page: 1,
  type: "paragraph",
  section: "body",
  runs: [{ t: text }],
  text,
  prov: box(1),
  ...over,
});

const noteBlock = (id: string, text: string, over: Partial<Block> = {}): Block => ({
  id,
  page: 2,
  type: "entry",
  section: "notes",
  runs: [{ t: text }],
  text,
  prov: box(2, 500),
  ...over,
});

const link = (over: Partial<PageLink> = {}): PageLink => ({
  page: 1,
  x: 100,
  y: 700,
  w: 40,
  h: 10,
  destPage: 2,
  destY: 500,
  url: null,
  ...over,
});

function linkRefs(blocks: Block[], links: PageLink[]): RefEdge[] {
  const { refs } = buildReferences(blocks, structure, [], [], { links });
  return refs.filter((r) => r.provenance === "explicit-link");
}

/** The characters the reader will make interactive for this reference. */
function interactiveText(b: Block, refs: RefEdge[], refId: string): string {
  const node = toReaderBlock(b, refs).inline.find((n) => n.ref?.id === refId);
  return node?.text ?? "";
}

describe("explicit internal links — exact source range", () => {
  it("anchors a single link on exactly the linked characters", () => {
    const src = block("b1", "He repeats the claim (1.136–40) later in the poem.");
    const dest = noteBlock("n1", "A note about the repeated claim.");
    const refs = linkRefs([src, dest], [link({ text: "(1.136–40)" })]);
    expect(refs).toHaveLength(1);
    const r = refs[0]!;
    expect(r.sourceText).toBe("(1.136–40)");
    expect(src.text.slice(r.marker.start, r.marker.end)).toBe("(1.136–40)");
    expect(r.provenance).toBe("explicit-link");
    expect(r.method).toBe("link");
    expect(r.to).toBe("n1");
    expect(interactiveText(src, refs, r.id)).toBe("(1.136–40)");
  });

  it("keeps the brackets of a linked marker and nothing more", () => {
    const src = block("b1", "She refused him[6] without hesitation.");
    const dest = noteBlock("n6", "6 She refused him twice.");
    const refs = linkRefs([src, dest], [link({ text: "6", x: 150, w: 6 })]);
    const r = refs[0]!;
    expect(r.sourceText).toBe("[6]");
    expect(interactiveText(src, refs, r.id)).toBe("[6]");
    // the word it abuts is never absorbed
    expect(r.sourceText).not.toContain("him");
  });

  it("anchors a link in the middle of a sentence without taking the sentence", () => {
    const src = block("b1", "The first clause, then (2.14) follows, and the sentence ends here.");
    const dest = noteBlock("n1", "A note.");
    const refs = linkRefs([src, dest], [link({ text: "(2.14)" })]);
    const r = refs[0]!;
    expect(r.sourceText).toBe("(2.14)");
    expect(r.sentence.start).toBe(0);
    expect(r.sentence.end).toBeGreaterThan(r.marker.end);
    expect(r.marker.end - r.marker.start).toBe("(2.14)".length);
  });

  it("keeps several links in one paragraph independent", () => {
    const src = block("b1", "Compare (1.5) with (2.7) and finally (3.9) in the same line.");
    const d1 = noteBlock("n1", "First note.");
    const d2 = noteBlock("n2", "Second note.", { prov: box(2, 400) });
    const d3 = noteBlock("n3", "Third note.", { prov: box(2, 300) });
    const refs = linkRefs(
      [src, d1, d2, d3],
      [
        link({ text: "(1.5)", destY: 500 }),
        link({ text: "(2.7)", destY: 400 }),
        link({ text: "(3.9)", destY: 300 }),
      ],
    );
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.sourceText).sort()).toEqual(["(1.5)", "(2.7)", "(3.9)"]);
    expect(new Set(refs.map((r) => r.to)).size).toBe(3);
    // three separate inline nodes, each covering only its own marker
    const nodes = toReaderBlock(src, refs).inline.filter((n) => n.ref);
    expect(nodes.map((n) => n.text)).toEqual(["(1.5)", "(2.7)", "(3.9)"]);
    for (const n of nodes) expect(src.text.slice(n.range.start, n.range.end)).toBe(n.text);
  });

  it("keeps two adjacent references separate", () => {
    const src = block("b1", "A disputed reading[6][7] in this line.");
    const d1 = noteBlock("n6", "6 First.");
    const d2 = noteBlock("n7", "7 Second.", { prov: box(2, 400) });
    const refs = linkRefs(
      [src, d1, d2],
      [link({ text: "6", destY: 500 }), link({ text: "7", destY: 400 })],
    );
    expect(refs.map((r) => r.sourceText)).toEqual(["[6]", "[7]"]);
    const nodes = toReaderBlock(src, refs).inline.filter((n) => n.ref);
    expect(nodes.map((n) => n.text)).toEqual(["[6]", "[7]"]);
    expect(nodes[0]!.range.end).toBe(nodes[1]!.range.start);
  });

  it("anchors a linked phrase without touching the prose around it", () => {
    const text = "Ordinary prose before the linked phrase of interest and ordinary prose after.";
    const src = block("b1", text);
    const dest = noteBlock("n1", "A discussion of the phrase.");
    const refs = linkRefs([src, dest], [link({ text: "the linked phrase of interest", w: 200 })]);
    const r = refs[0]!;
    expect(r.sourceText).toBe("the linked phrase of interest");
    expect(text.slice(0, r.marker.start)).toBe("Ordinary prose before ");
    expect(text.slice(r.marker.end)).toBe(" and ordinary prose after.");
    const nodes = toReaderBlock(src, refs).inline;
    expect(nodes.map((n) => n.text).join("")).toBe(text);
    expect(nodes.filter((n) => n.ref)).toHaveLength(1);
  });

  it("anchors a link whose covered text was broken across source lines", () => {
    const src = block("b1", "He cites the second book of the commentary here.");
    const dest = noteBlock("n1", "The commentary in question.");
    // the annotation's characters carry the line break the file printed
    const refs = linkRefs([src, dest], [link({ text: "second book\nof the commentary", w: 200 })]);
    const r = refs[0]!;
    expect(r.sourceText).toBe("second book of the commentary");
    expect(interactiveText(src, refs, r.id)).toBe("second book of the commentary");
  });

  it("anchors a link whose covered text was hyphenated at a line break", () => {
    const src = block("b1", "A note on the commentary tradition follows.");
    const dest = noteBlock("n1", "Tradition.");
    const refs = linkRefs([src, dest], [link({ text: "commen-\ntary tradition", w: 200 })]);
    expect(refs[0]!.sourceText).toBe("commentary tradition");
  });

  it("never turns the block, line or sentence into the reference", () => {
    const text = "One sentence with (4.2) inside. Another sentence entirely.";
    const src = block("b1", text);
    const dest = noteBlock("n1", "A note.");
    const refs = linkRefs([src, dest], [link({ text: "(4.2)" })]);
    const r = refs[0]!;
    expect(r.marker.start).toBeGreaterThan(0);
    expect(r.marker.end).toBeLessThan(text.length);
    expect(r.sourceText).toBe("(4.2)");
    expect(r.paragraph).toEqual({ blockId: "b1", start: 0, end: text.length });
  });
});

describe("explicit internal links — destination and provenance", () => {
  it("records source and destination provenance from the file itself", () => {
    const src = block("b1", "See (5.1) for the parallel.");
    const dest = noteBlock("n1", "The parallel passage.");
    const refs = linkRefs(
      [src, dest],
      [link({ text: "(5.1)", destPage: 2, destY: 500, id: "p1l0", charRange: { start: 4, end: 9 } })],
    );
    const r = refs[0]!;
    expect(r.link).toBeTruthy();
    expect(r.link!.page).toBe(1);
    expect(r.link!.destPage).toBe(2);
    expect(r.link!.destY).toBe(500);
    expect(r.link!.sourceCharRange).toEqual({ start: 4, end: 9 });
    expect(r.link!.sourceRange).toEqual({ start: r.marker.start, end: r.marker.end });
    expect(r.destinationNodeId).toBe("n1");
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it("resolves a destination whose note runs over several paragraphs", () => {
    const src = block("b1", "A claim (7.3) is made.");
    const head = noteBlock("n1", "First paragraph of the note.");
    const rest = noteBlock("n1b", "Second paragraph of the same note.", { prov: box(2, 480) });
    const blocks = [src, head, rest];
    const refs = linkRefs(blocks, [link({ text: "(7.3)" })]);
    const r = refs[0]!;
    expect(r.to).toBe("n1");
    // both destination paragraphs are already in the persisted model and share
    // the destination's section, so the popup needs no parsing to show them
    const destSection = blocks.find((b) => b.id === r.to)!.section;
    const continuation = blocks.filter((b) => b.section === destSection);
    expect(continuation.map((b) => b.id)).toEqual(["n1", "n1b"]);
  });

  it("keeps destination formatting available to the popup", () => {
    const src = block("b1", "A claim (8.4) is made.");
    const dest: Block = {
      ...noteBlock("n1", "A note with emphasis and bold."),
      runs: [{ t: "A note with " }, { t: "emphasis", em: true }, { t: " and " }, { t: "bold", strong: true }, { t: "." }],
    };
    const refs = linkRefs([src, dest], [link({ text: "(8.4)" })]);
    expect(refs[0]!.to).toBe("n1");
    const inline = toReaderBlock(dest, []).inline;
    expect(inline.find((n) => n.em)?.text).toBe("emphasis");
    expect(inline.find((n) => n.strong)?.text).toBe("bold");
    expect(inline.map((n) => n.text).join("")).toBe(dest.text);
  });

  it("marks a link with no resolvable destination instead of guessing one", () => {
    const src = block("b1", "A claim (9.9) is made.");
    const { refs, unresolved } = buildReferences([src], structure, [], [], {
      links: [link({ text: "(9.9)", destPage: null, destY: null })],
    });
    const r = refs.find((x) => x.provenance === "explicit-link")!;
    expect(r.sourceText).toBe("(9.9)");
    expect(r.to).toBeNull();
    expect(unresolved.some((u) => u.from === "b1")).toBe(true);
  });
});
