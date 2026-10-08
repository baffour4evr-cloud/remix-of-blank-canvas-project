import { describe, expect, it } from "vitest";

import { buildReferences } from "@/lib/reader/references";
import type { Block, RefEdge, StructureNode } from "@/lib/reader/types";

const node = (id: string, over: Partial<StructureNode> = {}): StructureNode => ({
  id, type: "chapter", label: id, number: null, title: "", page: 1, parent: "root", depth: 1, start: 0, end: 0, ...over,
});
const blk = (id: string, text: string, over: Partial<Block> = {}): Block => ({
  id, page: 1, type: "paragraph", section: "body", runs: [{ t: text }], text, ...over,
});

/** A small generic document: two chapters, an appendix, a figure, a table, notes, verse. */
function doc(source: string) {
  const blocks: Block[] = [
    blk("src", source, { section: "c1" }),
    blk("h5", "Chapter 5", { type: "heading", section: "c5", page: 5 }),
    blk("c5p", "Body of the fifth chapter.", { section: "c5", page: 5 }),
    blk("hA", "Appendix A", { type: "heading", section: "apA", page: 9 }),
    blk("apAp", "Appendix body.", { section: "apA", page: 9 }),
    blk("fig", "Figure 2.3 A diagram.", { type: "caption", section: "c5", page: 6 }),
    blk("tab", "Table 4 Some numbers.", { type: "caption", section: "c5", page: 7 }),
    blk("n36", "3.6 A note on the line.", { type: "entry", key: "3.6", section: "notes", page: 10 }),
    blk("v136", "A verse line", { type: "verse-line", line: 136, section: "b1", page: 11 }),
  ];
  const structure: StructureNode[] = [
    node("root", { type: "root", parent: null, depth: 0, end: blocks.length }),
    node("c1", { number: 1, label: "Chapter 1", start: 0, end: 1 }),
    node("c5", { number: 5, label: "Chapter 5", start: 1, end: 5, page: 5 }),
    node("apA", { type: "appendix", label: "Appendix A", start: 3, end: 5, page: 9 }),
    node("notes", { type: "apparatus", start: 7, end: 8 }),
    node("b1", { type: "book", number: 1, label: "Book 1", start: 8, end: 9 }),
  ];
  const pageMap = [{ pdfPage: 5, printed: 462, roman: false }];
  const { refs } = buildReferences(blocks, structure, [], [], { pageMap });
  return refs.filter((r) => r.from === "src");
}
const texts = (source: string, refs: RefEdge[]) => refs.map((r) => source.slice(r.marker.start, r.marker.end));

describe("semantic internal references without hyperlinks", () => {
  it("resolves a cued chapter reference to the smallest expression, as structural navigation", () => {
    const s = "See Chapter 5 for a discussion of the matter.";
    const refs = doc(s);
    expect(texts(s, refs)).toEqual(["Chapter 5"]);
    expect(refs[0]!.type).toBe("structural-navigation");
    expect(refs[0]!.toSection).toBe("c5");
    expect(refs[0]!.to).toBe("h5");
    expect(refs[0]!.provenance).toBe("inferred");
  });

  it("keeps several references in one paragraph independent", () => {
    const s = "See Chapter 5, Figure 2.3, and Appendix A.";
    const refs = doc(s);
    expect(texts(s, refs)).toEqual(["Chapter 5", "Figure 2.3", "Appendix A"]);
    expect(refs.map((r) => r.type)).toEqual(["structural-navigation", "figure", "appendix"]);
    expect(refs.map((r) => r.to)).toEqual(["h5", "fig", "hA"]);
  });

  it("resolves a section-style appendix reference", () => {
    const s = "Refer to Appendix A for the tables.";
    expect(doc(s)[0]!.toSection).toBe("apA");
  });

  it("resolves figure and table references to their captions", () => {
    const s = "The result (see Table 4) is clear.";
    const refs = doc(s);
    expect(texts(s, refs)).toEqual(["Table 4"]);
    expect(refs[0]!.to).toBe("tab");
  });

  it("resolves page references and ranges through the printed-page map", () => {
    const s = "This is argued on p. 462 and again at pp. 462–465 later.";
    const refs = doc(s);
    expect(texts(s, refs)).toEqual(["p. 462", "pp. 462–465"]);
    expect(refs.every((r) => r.type === "page-reference" && r.to === "h5")).toBe(true);
  });

  it("resolves a note-on reference and a cued line range", () => {
    const s = "See the note on 3.6 and compare 1.136–40 here.";
    const refs = doc(s);
    expect(texts(s, refs)).toEqual(["note on 3.6", "1.136–40"]);
    expect(refs[0]!.to).toBe("n36");
    expect(refs[1]!.to).toBe("v136");
  });

  it("keeps an open-ended ff locus exactly", () => {
    const s = "Compare 136ff. for the same idea.";
    expect(texts(s, doc(s))).toEqual(["136ff."]);
  });

  it("detects a reference spanning a physical source line", () => {
    const s = "Details are in the discussion; see Chapter\n5 for more.";
    const refs = doc(s);
    expect(texts(s, refs)).toEqual(["Chapter\n5"]);
    expect(refs[0]!.toSection).toBe("c5");
  });

  it("never highlights ordinary prose containing reference-like words or numbers", () => {
    for (const s of [
      "It was the first chapter of his life, and he knew it.",
      "She read the book in volume after volume, part by part.",
      "He paid 5 pounds for 1.5 yards of cloth in 1813.",
      "A table stood by the window; the figure 3 was carved on it.",
      "They met at the section of the road near 136 houses.",
      "Chapter 99 is what he called that year.",
    ]) {
      expect(doc(s), s).toEqual([]);
    }
  });

  it("marks an ambiguous reference instead of choosing a destination", () => {
    const blocks = [
      blk("src", "See Chapter 2 for this.", { section: "top" }),
      blk("a", "Chapter 2", { type: "heading", section: "v1c2" }),
      blk("b", "Chapter 2", { type: "heading", section: "v2c2" }),
    ];
    const structure = [
      node("top", { type: "frontmatter", start: 0, end: 1 }),
      node("v1", { type: "volume", number: 1, start: 1, end: 2 }),
      node("v1c2", { number: 2, parent: "v1", start: 1, end: 2 }),
      node("v2", { type: "volume", number: 2, start: 2, end: 3 }),
      node("v2c2", { number: 2, parent: "v2", start: 2, end: 3 }),
    ];
    const r = buildReferences(blocks, structure, [], []).refs[0]!;
    expect(r.ambiguous).toBe(true);
    expect(r.to).toBeNull();
    expect(r.candidates?.map((c) => c.to).sort()).toEqual(["a", "b"]);
  });

  it("marks an explicitly cued but missing destination unresolved, not invented", () => {
    const s = "See Chapter 12 for more.";
    const refs = doc(s);
    expect(texts(s, refs)).toEqual(["Chapter 12"]);
    expect(refs[0]!.to).toBeNull();
    expect(refs[0]!.method).toBe("unresolved");
  });
});
