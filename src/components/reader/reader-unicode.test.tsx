import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BlockView } from "./BlockView";
import type { Block, RefEdge } from "@/lib/reader/types";

const SAMPLE = "ḯ ï Ï Ḯ é e\u0301 Å A\u030A ﬁ ﬂ";

function blockWith(text: string): Block {
  return {
    id: "unicode-reader-regression",
    page: 1,
    type: "paragraph",
    section: "root",
    text,
    runs: [{ t: text }],
    prov: {
      page: 1,
      pages: [1],
      boxes: [{ page: 1, x: 0, y: 0, w: 100, h: 10 }],
      lines: 1,
    },
  };
}

function renderPersistedReaderText(text: string): string {
  const persisted = JSON.stringify({ blocks: [blockWith(text)] });
  const readerInput = JSON.parse(persisted) as { blocks: Block[] };
  const block = readerInput.blocks[0];
  if (!block) throw new Error("reader fixture lost its block");

  return renderToStaticMarkup(
    <BlockView
      block={block}
      prev={undefined}
      section={undefined}
      order={0}
      out={[]}
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

function renderBlocks(blocks: Block[], refs: RefEdge[] = []): string {
  return renderToStaticMarkup(
    <>
      {blocks.map((block, index) => (
        <BlockView
          key={block.id}
          block={block}
          prev={blocks[index - 1]}
          section={undefined}
          order={index}
          out={refs.filter((ref) => ref.from === block.id)}
          incoming={[]}
          debug={false}
          showDiagnostics={false}
          activeSystems={null}
          focused={false}
          refFocusId={null}
          onHover={() => undefined}
          onSelect={() => undefined}
          onRef={() => undefined}
        />
      ))}
    </>,
  );
}

describe("normalized text to reader rendering", () => {
  it("keeps precomposed ḯ unchanged through persistence and React text generation", () => {
    const html = renderPersistedReaderText("ḯ");
    expect(html).toContain("ḯ");
    expect([..."ḯ"].map((character) => character.codePointAt(0))).toEqual([0x1e2f]);
  });

  it("preserves precomposed characters, decomposed accents, and ligatures exactly", () => {
    const html = renderPersistedReaderText(SAMPLE);
    expect(html).toContain(SAMPLE);
    expect(JSON.parse(JSON.stringify(SAMPLE))).toBe(SAMPLE);
    expect([...SAMPLE].map((character) => character.codePointAt(0))).toEqual([
      0x1e2f, 0x20, 0xef, 0x20, 0xcf, 0x20, 0x1e2e, 0x20, 0xe9, 0x20,
      0x65, 0x301, 0x20, 0xc5, 0x20, 0x41, 0x30a, 0x20, 0xfb01, 0x20, 0xfb02,
    ]);
  });

  it("renders one reader block with inline formatting and an inline reference marker", () => {
    const block: Block = {
      ...blockWith("Elizabeth's sense and conduct[6] remains continuous."),
      id: "inline-reader-regression",
      runs: [
        { t: "Elizabeth's ", sources: [{ page: 1, o: 0 }] },
        { t: "sense", em: true, sources: [{ page: 1, o: 1 }] },
        { t: " and ", sources: [{ page: 1, o: 2 }] },
        { t: "conduct", strong: true, sources: [{ page: 1, o: 3 }] },
        { t: "[6]", sup: true, sources: [{ page: 1, o: 4 }] },
        { t: " remains continuous.", sources: [{ page: 1, o: 5 }] },
      ],
    };
    const start = block.text.indexOf("[6]");
    const ref: RefEdge = {
      id: "r6",
      type: "footnote",
      system: "notes",
      from: block.id,
      at: start,
      label: "[6]",
      to: null,
      toSection: null,
      method: "marker",
      confidence: 1,
      key: "6",
      marker: { blockId: block.id, start, end: start + 3 },
      sentence: { blockId: block.id, start: 0, end: block.text.length },
      paragraph: { blockId: block.id, start: 0, end: block.text.length },
      destinationNodeId: null,
      evidence: [],
      sourceText: "[6]",
      targetLocation: null,
      provenance: "inferred",
    };
    const html = renderBlocks([block], [ref]);
    expect((html.match(/data-block=/g) ?? [])).toHaveLength(1);
    expect((html.match(/<p/g) ?? [])).toHaveLength(1);
    expect((html.match(/data-ref=/g) ?? [])).toHaveLength(1);
    expect(html).toContain('data-inline="reference-marker"');
    expect(html).toContain("Elizabeth&#x27;s ");
    expect(html).toContain("[6]");
  });

  it("renders normalized paragraph, heading, and verse boundaries unchanged", () => {
    const paragraphA = { ...blockWith("Paragraph A."), id: "p-a" };
    const paragraphB = { ...blockWith("Paragraph B."), id: "p-b" };
    const heading = { ...blockWith("Heading"), id: "h", type: "heading" as const };
    const verseA = { ...blockWith("Verse A"), id: "v-a", type: "verse-line" as const };
    const verseB = { ...blockWith("Verse B"), id: "v-b", type: "verse-line" as const };
    const html = renderBlocks([paragraphA, paragraphB, heading, verseA, verseB]);
    expect((html.match(/data-block=/g) ?? [])).toHaveLength(5);
    expect((html.match(/<p/g) ?? [])).toHaveLength(2);
    expect((html.match(/<h2/g) ?? [])).toHaveLength(1);
    expect((html.match(/class="flex gap-3/g) ?? [])).toHaveLength(2);
  });
});