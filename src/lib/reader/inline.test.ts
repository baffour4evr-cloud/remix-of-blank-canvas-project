import { describe, expect, it } from "vitest";

import { inlineText, toReaderBlock } from "./inline";
import type { Block, RefEdge, RefType, Run } from "./types";

const provenance = {
  page: 1,
  pages: [1],
  boxes: [{ page: 1, x: 100, y: 700, w: 300, h: 10 }],
  lines: 2,
  sources: [{ page: 1, o: 0 }, { page: 1, o: 1 }],
};

function block(id: string, type: Block["type"], runs: Run[]): Block {
  return { id, page: 1, type, section: "s1", runs, text: runs.map((run) => run.t).join(""), prov: provenance };
}

function ref(host: Block, sourceText: string, type: RefType = "citation", provenanceType: RefEdge["provenance"] = "inferred"): RefEdge {
  const start = host.text.indexOf(sourceText);
  return {
    id: `r-${sourceText}`,
    type,
    system: null,
    from: host.id,
    at: start,
    label: sourceText,
    to: null,
    toSection: null,
    method: provenanceType === "explicit-link" ? "link" : "marker",
    confidence: 1,
    key: sourceText,
    marker: { blockId: host.id, start, end: start + sourceText.length },
    sentence: { blockId: host.id, start: 0, end: host.text.length },
    paragraph: { blockId: host.id, start: 0, end: host.text.length },
    destinationNodeId: null,
    evidence: [],
    sourceText,
    targetLocation: null,
    provenance: provenanceType,
  };
}

describe("normalized model to reader representation", () => {
  it("keeps continuous prose and multiple source spans in one reader block", () => {
    const source = block("p1", "paragraph", [
      { t: "share the tale ", sources: [{ page: 1, o: 0 }] },
      { t: "with us too", sources: [{ page: 1, o: 1 }] },
    ]);
    const reader = toReaderBlock(source);
    expect(reader.block).toBe(source);
    expect(inlineText(reader)).toBe(source.text);
    expect(reader.inline.flatMap((node) => node.sources)).toEqual([{ page: 1, o: 0 }, { page: 1, o: 1 }]);
  });

  it.each(["[6]", "(1.136–40)"])("keeps %s as an inline reference marker", (marker) => {
    const source = block("p1", "paragraph", [{ t: `Words before ${marker}, and words after.` }]);
    const reader = toReaderBlock(source, [ref(source, marker)]);
    expect(reader.inline.find((node) => node.text === marker)?.type).toBe("reference-marker");
    expect(inlineText(reader)).toBe(source.text);
  });

  it("keeps a hyperlink inline", () => {
    const source = block("p1", "paragraph", [{ t: "Read the linked passage here." }]);
    const reader = toReaderBlock(source, [ref(source, "linked passage", "external", "explicit-link")]);
    expect(reader.inline.find((node) => node.text === "linked passage")?.type).toBe("hyperlink");
    expect(inlineText(reader)).toBe(source.text);
  });

  it("does not crash when opening a legacy block with missing text", () => {
    const source = block("legacy", "paragraph", [{ t: "orphaned run" }]);
    const malformed = { ...source, text: undefined } as unknown as Block;
    expect(() => toReaderBlock(malformed)).not.toThrow();
    expect(inlineText(toReaderBlock(malformed))).toBe("");
  });

  it("keeps italic, bold, small-caps, and superscript spans inline", () => {
    const source = block("p1", "paragraph", [
      { t: "Plain ", sources: [{ page: 1, o: 0 }] },
      { t: "italic", em: true, sources: [{ page: 1, o: 1 }] },
      { t: ", ", sources: [{ page: 1, o: 2 }] },
      { t: "bold", strong: true, sources: [{ page: 1, o: 3 }] },
      { t: ", ", sources: [{ page: 1, o: 4 }] },
      { t: "SMALL CAPS", sc: true, sources: [{ page: 1, o: 5 }] },
      { t: "6", sup: true, sources: [{ page: 1, o: 6 }] },
      { t: ".", sources: [{ page: 1, o: 7 }] },
    ]);
    const reader = toReaderBlock(source, [ref(source, "6", "footnote")]);
    expect(reader.inline.map((node) => node.type)).toEqual([
      "text", "emphasis", "text", "strong", "text", "small-caps", "reference-marker", "text",
    ]);
    expect(inlineText(reader)).toBe(source.text);
  });

  it("preserves normalized paragraph, heading, and verse block boundaries", () => {
    const blocks = [
      block("p1", "paragraph", [{ t: "First paragraph." }]),
      block("p2", "paragraph", [{ t: "Second paragraph." }]),
      block("h1", "heading", [{ t: "A Heading" }]),
      block("v1", "verse-line", [{ t: "First verse line" }]),
      block("v2", "verse-line", [{ t: "Second verse line" }]),
    ];
    const readerBlocks = blocks.map((source) => toReaderBlock(source));
    expect(readerBlocks).toHaveLength(5);
    expect(readerBlocks.map(({ block: source }) => source.type)).toEqual([
      "paragraph", "paragraph", "heading", "verse-line", "verse-line",
    ]);
    expect(readerBlocks.map(inlineText)).toEqual(blocks.map((source) => source.text));
  });
});