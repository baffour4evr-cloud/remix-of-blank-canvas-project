import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BlockView } from "./BlockView";
import { inlineText, toReaderBlock } from "@/lib/reader/inline";
import type { Block, RefEdge, Run } from "@/lib/reader/types";

function block(id: string, runs: Run[], type: Block["type"] = "paragraph"): Block {
  return {
    id,
    page: 1,
    type,
    section: "root",
    runs,
    text: runs.map((run) => run.t).join(""),
    prov: { page: 1, pages: [1], boxes: [{ page: 1, x: 0, y: 0, w: 100, h: 10 }], lines: 1 },
  };
}

function refFor(host: Block, sourceText: string, id = `r-${sourceText}`, explicitLink = false): RefEdge {
  const start = host.text.indexOf(sourceText);
  const end = start + sourceText.length;
  return {
    id,
    type: explicitLink ? "external" : "citation",
    system: null,
    from: host.id,
    at: start,
    label: sourceText,
    to: null,
    toSection: null,
    method: explicitLink ? "link" : "marker",
    confidence: 1,
    key: sourceText,
    marker: { blockId: host.id, start, end },
    sentence: { blockId: host.id, start: 0, end: host.text.length },
    paragraph: { blockId: host.id, start: 0, end: host.text.length },
    destinationNodeId: null,
    evidence: [],
    sourceText,
    targetLocation: null,
    provenance: explicitLink ? "explicit-link" : "inferred",
  };
}

function render(source: Block, refs: RefEdge[] = []): string {
  const roundTripped = JSON.parse(JSON.stringify(source)) as Block;
  return renderToStaticMarkup(
    <BlockView
      block={roundTripped}
      prev={undefined}
      section={undefined}
      order={0}
      out={refs}
      incoming={[]}
      debug={false}
      showDiagnostics={false}
      activeSystems={null}
      focused={false}
      refFocusId={null}
      onHover={() => undefined}
      onSelect={() => undefined}
      onRef={() => undefined}
    />,
  );
}

describe("reader text invariant", () => {
  const cases: { name: string; runs: Run[] }[] = [
    { name: "all caps structural text", runs: [{ t: "VOLUME I" }] },
    { name: "all caps chapter text", runs: [{ t: "CHAPTER 1" }] },
    { name: "mixed case title", runs: [{ t: "Chapter 1" }] },
    { name: "small caps run", runs: [{ t: "volume", sc: true }, { t: " I" }] },
    { name: "small caps caps run", runs: [{ t: "JANE AUSTEN", sc: true }, { t: " was born" }] },
    { name: "smaller font passage", runs: [{ t: "small font", sources: [{ page: 1, o: 3 }] }] },
    { name: "precomposed and decomposed", runs: [{ t: "ḯ ï Ï Ḯ é e\u0301 Å A\u030A" }] },
    { name: "ligatures", runs: [{ t: "ﬁ ﬂ ﬃ" }] },
    { name: "ordinary prose", runs: [{ t: "share the tale with us too" }] },
    { name: "italic inside a sentence", runs: [{ t: "the " }, { t: "Iliad", em: true }, { t: " again" }] },
    { name: "bold inside a sentence", runs: [{ t: "a " }, { t: "strong", strong: true }, { t: " claim" }] },
    { name: "superscript marker", runs: [{ t: "conduct" }, { t: "6", sup: true }, { t: " next" }] },
    { name: "bracketed marker", runs: [{ t: "conduct [6] next" }] },
    { name: "parenthetical citation", runs: [{ t: "cited (1.136–40) here" }] },
    { name: "open-ended page range", runs: [{ t: "see 508ff. below" }] },
  ];

  it.each(cases)("inline nodes concatenate back to the normalized text for $name", ({ runs }) => {
    const source = block("b", runs);
    expect(inlineText(toReaderBlock(source))).toBe(source.text);
    expect([...inlineText(toReaderBlock(source))].map((c) => c.codePointAt(0))).toEqual(
      [...source.text].map((c) => c.codePointAt(0)),
    );
  });

  it.each(cases)("rendered reader markup contains the normalized text for $name", ({ runs }) => {
    const source = block("b", runs);
    const html = render(source);
    // the markup may split runs into elements, so compare the text content
    const text = html.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
    expect(text).toContain(source.text);
  });

  it("never changes case: VOLUME I stays VOLUME I", () => {
    const source = block("b", [{ t: "VOLUME I" }]);
    const html = render(source);
    expect(html).toContain("VOLUME I");
    expect(html).not.toContain("volume i");
  });

  it("keeps small caps as a font variant rather than a case change", () => {
    const source = block("b", [{ t: "volume", sc: true }, { t: " I" }]);
    const html = render(source);
    expect(html).toContain("volume");
    expect(html).toContain("small-caps");
    expect(html).not.toContain("VOLUME");
  });

  it("defines the small-caps utility the reader relies on", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/@utility small-caps\s*\{[^}]*font-variant-caps/);
  });

  it("keeps a reference range attached to its own characters across source lines", () => {
    const phrase = "wrapped them in cloaks of wool and got them into their tunics";
    const source = block("b", [
      { t: "They ", sources: [{ page: 1, o: 0 }] },
      { t: "wrapped them in cloaks of wool ", sources: [{ page: 1, o: 1 }] },
      { t: "and got them into their tunics", sources: [{ page: 1, o: 2 }] },
      { t: " and their cloaks after.", sources: [{ page: 1, o: 3 }] },
    ]);
    const ref = refFor(source, phrase);
    const marked = toReaderBlock(source, [ref]).inline.filter((node) => node.ref?.id === ref.id);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.text).toBe(phrase);
    expect(marked[0]!.range.end).toBe(ref.marker.end);
    const html = render(source, [ref]);
    expect((html.match(/data-ref=/g) ?? [])).toHaveLength(1);
    expect(inlineText(toReaderBlock(source, [ref]))).toBe(source.text);
  });

  it("does not highlight text outside the reference range", () => {
    const source = block("b", [{ t: "ten talents of gold and ten of silver" }]);
    const ref = refFor(source, "ten talents of gold");
    const nodes = toReaderBlock(source, [ref]).inline;
    expect(nodes.filter((n) => n.ref).map((n) => n.text)).toEqual(["ten talents of gold"]);
    expect(nodes.filter((n) => !n.ref).map((n) => n.text).join("")).toBe(" and ten of silver");
  });

  it("keeps every reference and hyperlink inline inside one block", () => {
    const source = block("b", [
      { t: "First " },
      { t: "[6]", sup: true },
      { t: " then a link here and " },
      { t: "(1.136–40)" },
      { t: " last." },
    ]);
    const refs = [
      refFor(source, "[6]", "marker"),
      refFor(source, "link", "hyper", true),
      refFor(source, "(1.136–40)", "cite"),
    ];
    const reader = toReaderBlock(source, refs);
    expect(reader.inline.filter((n) => n.ref).map((n) => n.ref!.id)).toEqual(["marker", "hyper", "cite"]);
    expect(reader.inline.filter((n) => n.ref).map((n) => n.type)).toEqual([
      "reference-marker", "hyperlink", "reference-marker",
    ]);
    const html = render(source, refs);
    expect((html.match(/<p/g) ?? [])).toHaveLength(1);
    expect((html.match(/data-ref=/g) ?? [])).toHaveLength(3);
  });

  it("keeps an open-ended range as the supplied range, not the literal ff token", () => {
    const source = block("b", [{ t: "discussed at 508ff. in the appendix" }]);
    const ref = refFor(source, "508ff.");
    const marked = toReaderBlock(source, [ref]).inline.find((n) => n.ref);
    expect(marked?.text).toBe("508ff.");
    expect(marked?.text).not.toBe("ff");
    expect(marked?.range).toEqual({ blockId: source.id, start: ref.marker.start, end: ref.marker.end });
  });
});
