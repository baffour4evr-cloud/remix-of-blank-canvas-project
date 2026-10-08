import { describe, expect, it } from "vitest";

import { buildLexicon, classifyEmbedded, joinerFor, repairGluedTokens } from "./content";
import type { Block, Run } from "./types";

function lines(...texts: string[]) {
  return [{ page: 1, lines: texts.map((t) => ({ text: t })) }] as never;
}

function block(id: string, text: string, boxes: { x: number; y: number; w: number; h: number }[]): Block {
  const runs: Run[] = [{ t: text, em: false, sup: false }];
  return {
    id,
    page: 1,
    type: "paragraph",
    section: "s0",
    runs,
    text,
    prov: { page: 1, boxes: boxes.map((b) => ({ ...b, page: 1 })) } as never,
  };
}

const profile = { bodySize: 10, proseLeft: 100, maxRight: 400, bodyIndent: 12 } as never;

describe("hyphenation", () => {
  const lex = buildLexicon(lines("a well-known man walked", "the well-known road", "sud denly he ran"));

  it("keeps a hyphen the document prints away from a line break", () => {
    expect(joinerFor("a well-", "known man", lex)).toBe("-");
  });

  it("drops a break hyphen for a compound the document never hyphenates", () => {
    expect(joinerFor("sud-", "denly he ran", lex)).toBe("");
  });

  it("separates two lines that are not hyphenated at all", () => {
    expect(joinerFor("the road", "was long", lex)).toBe(" ");
  });
});

describe("glued token repair", () => {
  it("splits a long unattested fusion the document elsewhere prints as two words", () => {
    const lex = buildLexicon(
      lines(
        "Alkínoös and the others",
        "Alkínoös and his men",
        "Alkínoös and the queen",
        "Alkínoös and the hall",
      ),
    );
    const b = block("b1", "Alkínoösand the queen", [{ x: 100, y: 0, w: 200, h: 10 }]);
    const applied = repairGluedTokens([b], lex);
    expect(b.text).toBe("Alkínoös and the queen");
    expect(applied).toHaveLength(1);
  });

  it("never splits an ordinary word, even when both halves are frequent", () => {
    const lex = buildLexicon(lines("every day she came", "every day he left", "every day again", "every day"));
    const b = block("b2", "an everyday thing", [{ x: 100, y: 0, w: 200, h: 10 }]);
    repairGluedTokens([b], lex);
    expect(b.text).toBe("an everyday thing");
  });
});

describe("embedded regions", () => {
  it("marks a run of smaller paragraphs as a block quotation", () => {
    const blocks = [
      block("p1", "running prose here", [{ x: 100, y: 0, w: 300, h: 10 }]),
      block("q1", "the quoted opening line of the passage", [{ x: 120, y: 0, w: 250, h: 8 }]),
      block("q2", "and the quotation continues to its end", [{ x: 120, y: 0, w: 250, h: 8 }]),
      block("p2", "prose resumes here", [{ x: 100, y: 0, w: 300, h: 10 }]),
    ];
    classifyEmbedded(blocks, profile);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "blockquote", "blockquote", "paragraph"]);
    expect(blocks[1]!.groupEdge).toBe("start");
    expect(blocks[2]!.groupEdge).toBe("end");
    expect(blocks[1]!.group).toBe(blocks[2]!.group);
  });

  it("leaves a lone smaller paragraph as prose", () => {
    const blocks = [block("c1", "a credit line set small", [{ x: 100, y: 0, w: 300, h: 8 }])];
    classifyEmbedded(blocks, profile);
    expect(blocks[0]!.type).toBe("paragraph");
  });

  it("groups consecutive marked paragraphs into a list", () => {
    const blocks = [
      block("l1", "• first item", [{ x: 120, y: 0, w: 200, h: 10 }]),
      block("l2", "• second item", [{ x: 120, y: 0, w: 200, h: 10 }]),
    ];
    classifyEmbedded(blocks, profile);
    expect(blocks.every((b) => b.type === "list-item")).toBe(true);
  });
});
