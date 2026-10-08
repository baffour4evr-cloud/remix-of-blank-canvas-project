import { describe, expect, it } from "vitest";

import { inlineText, toReaderBlock } from "./inline";
import type { Block, BlockType, RefEdge, RefType, Run } from "./types";

function block(id: string, type: BlockType, runs: Run[]): Block {
  return {
    id,
    page: 1,
    type,
    section: "s1",
    runs,
    text: runs.map((run) => run.t).join(""),
    prov: { page: 1, pages: [1], boxes: [{ page: 1, x: 0, y: 0, w: 10, h: 10 }], lines: 1, sources: [{ page: 1, o: 0 }] },
  };
}

function refFor(
  host: Block,
  sourceText: string,
  type: RefType = "citation",
  provenance: RefEdge["provenance"] = "inferred",
  id = `r-${sourceText}`,
): RefEdge {
  const start = host.text.indexOf(sourceText);
  const end = start + sourceText.length;
  return {
    id,
    type,
    system: null,
    from: host.id,
    at: start,
    label: sourceText,
    to: null,
    toSection: null,
    method: provenance === "explicit-link" ? "link" : "marker",
    confidence: 1,
    key: sourceText,
    marker: { blockId: host.id, start, end },
    sentence: { blockId: host.id, start: 0, end: host.text.length },
    paragraph: { blockId: host.id, start: 0, end: host.text.length },
    destinationNodeId: null,
    evidence: [],
    sourceText,
    targetLocation: null,
    provenance,
  };
}

describe("reader inline invariants", () => {
  const cases: { name: string; runs: Run[] }[] = [
    { name: "uppercase", runs: [{ t: "VOLUME I" }] },
    { name: "chapter heading text", runs: [{ t: "CHAPTER 1" }] },
    { name: "lowercase", runs: [{ t: "volume one" }] },
    { name: "small caps run", runs: [{ t: "Volume", sc: true }, { t: " one" }] },
    { name: "accented and combining", runs: [{ t: "ḯ ï Ï Ḯ é e\u0301 Å A\u030A" }] },
    { name: "ligatures", runs: [{ t: "ﬁ ﬂ ﬃ" }] },
    { name: "mixed fonts and sizes", runs: [{ t: "large " }, { t: "small", em: true }, { t: " large" }] },
    { name: "whitespace and punctuation", runs: [{ t: "one  two — three… “four”, ‘five’;" }] },
  ];

  it.each(cases)("preserves text exactly for $name", ({ runs }) => {
    const source = block("b", "paragraph", runs);
    const reader = toReaderBlock(source);
    expect(inlineText(reader)).toBe(source.text);
    expect([...inlineText(reader)].map((c) => c.codePointAt(0))).toEqual(
      [...source.text].map((c) => c.codePointAt(0)),
    );
  });

  it("keeps every inline semantic type inline in one block", () => {
    const source = block("b", "paragraph", [
      { t: "Plain " },
      { t: "emphasis", em: true },
      { t: " " },
      { t: "strong", strong: true },
      { t: " " },
      { t: "CAPS", sc: true },
      { t: "up", sup: true },
      { t: "down", sub: true },
      { t: "code", code: true },
      { t: " link tail." },
    ]);
    const reader = toReaderBlock(source, [refFor(source, "link", "external", "explicit-link")]);
    expect(reader.inline.map((n) => n.type)).toEqual([
      "text", "emphasis", "text", "strong", "text", "small-caps",
      "superscript", "subscript", "inline-code", "text", "hyperlink", "text",
    ]);
    expect(inlineText(reader)).toBe(source.text);
  });

  it.each<[string, BlockType]>([
    ["paragraph", "paragraph"],
    ["heading", "heading"],
    ["verse-line", "verse-line"],
    ["blockquote", "blockquote"],
    ["list-item", "list-item"],
    ["caption", "caption"],
  ])("renders %s as exactly one reader block", (_name, type) => {
    const source = block("b", type, [{ t: "Some " }, { t: "content", em: true }, { t: " here." }]);
    const reader = toReaderBlock(source);
    expect(reader.block.type).toBe(type);
    expect(inlineText(reader)).toBe(source.text);
  });

  describe("reference ranges", () => {
    const rangeOf = (source: Block, refs: RefEdge[], id: string) => {
      const nodes = toReaderBlock(source, refs).inline.filter((n) => n.ref?.id === id);
      expect(nodes).toHaveLength(1);
      const node = nodes[0]!;
      return { start: node.range.start, end: node.range.end, text: node.text };
    };

    it("preserves a short numeric marker range", () => {
      const source = block("b", "paragraph", [{ t: "Elizabeth's conduct" }, { t: "6", sup: true }, { t: " continued." }]);
      const ref = refFor(source, "6", "footnote");
      expect(rangeOf(source, [ref], ref.id)).toEqual({ start: ref.marker.start, end: ref.marker.end, text: "6" });
    });

    it("preserves a symbolic marker adjacent to punctuation", () => {
      const source = block("b", "paragraph", [{ t: "the wool, †, and the tunics." }]);
      const ref = refFor(source, "†", "note");
      const got = rangeOf(source, [ref], ref.id);
      expect(got).toEqual({ start: ref.marker.start, end: ref.marker.end, text: "†" });
    });

    it("keeps a multi-word range that crosses a source line as one inline node", () => {
      const source = block("b", "paragraph", [
        { t: "They ", sources: [{ page: 1, o: 0 }] },
        { t: "wrapped them in cloaks of wool ", sources: [{ page: 1, o: 1 }] },
        { t: "and got them into their tunics", sources: [{ page: 1, o: 2 }] },
        { t: " before dawn.", sources: [{ page: 1, o: 3 }] },
      ]);
      const phrase = "wrapped them in cloaks of wool and got them into their tunics";
      const ref = refFor(source, phrase, "cross-reference");
      const got = rangeOf(source, [ref], ref.id);
      expect(got).toEqual({ start: ref.marker.start, end: ref.marker.end, text: phrase });
      expect(inlineText(toReaderBlock(source, [ref]))).toBe(source.text);
    });

    it("never leaks a range into adjacent text", () => {
      const source = block("b", "paragraph", [{ t: "see p. 6 and then the next line follows." }]);
      const ref = refFor(source, "p. 6", "page-reference");
      const got = rangeOf(source, [ref], ref.id);
      expect(got.text).toBe("p. 6");
      expect(got.end).toBe(ref.marker.end);
    });

    it("preserves an open-ended ff range as supplied, not as the literal ff", () => {
      const source = block("b", "paragraph", [{ t: "discussed at pp. 121ff. in the appendix." }]);
      const ref = refFor(source, "pp. 121ff.", "page-reference");
      const got = rangeOf(source, [ref], ref.id);
      expect(got.text).toBe("pp. 121ff.");
      expect(got.text).not.toBe("ff");
    });

    it("keeps every reference in a block with several references", () => {
      const source = block("b", "paragraph", [{ t: "First [1], then * and finally a link here." }]);
      const refs = [
        refFor(source, "[1]", "footnote", "inferred", "a"),
        refFor(source, "*", "note", "inferred", "b"),
        refFor(source, "link", "external", "explicit-link", "c"),
      ];
      const reader = toReaderBlock(source, refs);
      expect(reader.inline.filter((n) => n.ref).map((n) => n.ref!.id)).toEqual(["a", "b", "c"]);
      expect(reader.inline.filter((n) => n.ref).map((n) => n.type)).toEqual([
        "reference-marker", "reference-marker", "hyperlink",
      ]);
      expect(inlineText(reader)).toBe(source.text);
    });

    it("drops neither text nor a reference when ranges overlap", () => {
      const source = block("b", "paragraph", [{ t: "cited as Iliad 1.136–40 in the note." }]);
      const outer = refFor(source, "Iliad 1.136–40", "citation", "inferred", "outer");
      const inner = refFor(source, "1.136–40", "citation", "inferred", "inner");
      const reader = toReaderBlock(source, [outer, inner]);
      expect(inlineText(reader)).toBe(source.text);
      expect(reader.inline.filter((n) => n.ref).map((n) => n.ref!.id)).toEqual(["outer"]);
    });
  });
});
