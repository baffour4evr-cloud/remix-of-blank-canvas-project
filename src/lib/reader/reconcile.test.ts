import { describe, expect, it } from "vitest";

import { detectApparatus } from "@/lib/reader/apparatus";
import { detectPageNotes } from "@/lib/reader/footnotes";
import { reconcile, recognitionScore, type Proposed } from "@/lib/reader/reconcile";
import { buildReferences, type PageLink } from "@/lib/reader/references";
import type { Block, RefEdge, Run, StructureNode } from "@/lib/reader/types";

// Classes of documents, built synthetically. No book, title or phrase is known
// to the engine; every assertion is a general behavioural rule.

function para(id: string, parts: string[], over: Partial<Block> = {}): Block {
  const runs: Run[] = parts.map((p) => (p.startsWith("^") ? { t: p.slice(1), sup: true } : { t: p }));
  return { id, page: 1, type: "paragraph", section: "c1", runs, text: runs.map((r) => r.t).join(""), ...over };
}

const node = (id: string, type: StructureNode["type"], label: string, number: number | null, start: number, end: number, page = 1, parent: string | null = "root"): StructureNode => ({
  id, type, label, number, title: "", page, parent, depth: parent ? 1 : 0, start, end,
});

/** two chapters of body text, then one notes section per list */
function doc(c1: Block[], c2: Block[], notes: { label: string; entries: string[] }[] = []) {
  const blocks: Block[] = [
    { ...para("h1", ["Chapter 1"]), type: "heading" },
    ...c1,
    { ...para("h2", ["Chapter 2"], { section: "c2", page: 20 }), type: "heading" },
    ...c2.map((b) => ({ ...b, section: "c2" })),
  ];
  const structure: StructureNode[] = [
    node("root", "root", "", null, 0, 0, 1, null),
    node("c1", "chapter", "Chapter 1", 1, 0, c1.length + 1),
    node("c2", "chapter", "Chapter 2", 2, c1.length + 1, c1.length + c2.length + 2, 20),
  ];
  notes.forEach((n, k) => {
    const start = blocks.length;
    n.entries.forEach((t, i) => blocks.push(para(`n${k}_${i}`, [t], { section: `notes${k}`, page: 50 + k })));
    structure.push({ ...node(`notes${k}`, "apparatus", n.label, null, start, blocks.length, 50 + k), title: n.label });
  });
  structure[0]!.end = blocks.length;
  return { blocks, structure };
}

function run(d: ReturnType<typeof doc>, links: PageLink[] = []) {
  const { systems, entries } = detectApparatus(d.blocks, d.structure, false);
  const page = detectPageNotes(d.blocks, d.structure, systems.length);
  systems.push(...page.systems);
  entries.push(...page.entries);
  const out = buildReferences(d.blocks, d.structure, systems, entries, { links });
  const text = (r: RefEdge) => d.blocks.find((b) => b.id === r.from)!.text.slice(r.marker.start, r.marker.end);
  const dest = (r: RefEdge) => d.blocks.find((b) => b.id === r.to)?.text ?? null;
  return { ...out, systems, text, dest };
}

const NUMBERED = ["1. Note one.", "2. Note two.", "3. Note three.", "4. Note four."];

describe("recognition is separate from resolution", () => {
  it("scores combined evidence, and penalties override weak signals", () => {
    expect(recognitionScore([{ kind: "explicit-link" }])).toBeGreaterThan(0.95);
    expect(recognitionScore([{ kind: "superscript" }, { kind: "system-key" }])).toBeGreaterThan(0.8);
    expect(recognitionScore([{ kind: "intrinsic-form" }, { kind: "vocabulary-only" }])).toBeLessThan(0.4);
    expect(recognitionScore([{ kind: "superscript" }, { kind: "math-context" }])).toBeLessThan(0.4);
  });

  it("rejects a destination that contradicts the marker's identity, keeping the candidate unresolved", () => {
    const d = doc([para("p1", ["Text", "^2", "."])], [], [{ label: "Notes", entries: NUMBERED }]);
    const wrong: Proposed = {
      id: "x", type: "note", system: null, from: "p1", at: 4, label: "2", to: "n0_2", toSection: null,
      method: "marker", confidence: 0.9, key: "2", marker: { blockId: "p1", start: 4, end: 5 },
      sentence: { blockId: "p1", start: 0, end: 6 }, paragraph: { blockId: "p1", start: 0, end: 6 },
      destinationNodeId: "n0_2", evidence: [], sourceText: "2", targetLocation: null, provenance: "inferred",
      signals: [{ kind: "superscript" }], exact: true,
    };
    const { blocks, structure } = d;
    const sys = detectApparatus(blocks, structure, false);
    const { refs, records } = reconcile([wrong], { blocks, structure, ...sys });
    expect(refs[0]!.to).toBeNull();
    expect(records[0]!.decision).toBe("accepted-unresolved");
    expect(records[0]!.reason).toMatch(/keyed "3"/);
  });
});

describe("explicit links", () => {
  it("never drops one file link for another overlapping link", () => {
    const d = doc([para("p1", ["Linked phrase here."])], [para("p2", ["x"])]);
    const mk = (id: string, start: number, end: number, toSection: string): Proposed => ({
      id, type: "structural-navigation", system: null, from: "p1", at: start, label: "x", to: null, toSection,
      method: "link", confidence: 0.99, key: "x", marker: { blockId: "p1", start, end },
      sentence: { blockId: "p1", start: 0, end: 19 }, paragraph: { blockId: "p1", start: 0, end: 19 },
      destinationNodeId: null, evidence: [], sourceText: "Linked phrase here.".slice(start, end), targetLocation: null,
      provenance: "explicit-link", signals: [{ kind: "explicit-link" }], exact: true,
    });
    const { refs } = reconcile([mk("a", 0, 13, "c1"), mk("b", 7, 18, "c2")], { ...d, systems: [], entries: [] });
    expect(refs.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  const box = (page: number, y: number) => ({ page, pages: [page], lines: 1, boxes: [{ page, x: 50, y, w: 300, h: 15 }] });
  it("stay the strongest evidence and absorb the marker detector's duplicate", () => {
    const d = doc([para("p1", ["A word[2] here."], { prov: box(1, 700) })], [], [{ label: "Notes", entries: NUMBERED }]);
    d.blocks.forEach((b, i) => {
      if (b.section === "notes0") b.prov = box(50, 700 - i * 30);
    });
    const target = d.blocks.find((b) => b.text.startsWith("2."))!;
    const { refs, recognition, text, dest } = run(d, [
      { page: 1, x: 100, y: 700, w: 20, h: 15, destPage: 50, destY: target.prov!.boxes[0]!.y + 10, url: null, text: "[2]" },
    ]);
    expect(refs).toHaveLength(1);
    expect(text(refs[0]!)).toBe("[2]");
    expect(refs[0]!.provenance).toBe("explicit-link");
    expect(dest(refs[0]!)).toBe("2. Note two.");
    expect(refs[0]!.recognition!.score).toBeGreaterThan(0.95);
    expect(recognition.every((r) => r.decision !== "rejected" || r.reason.length > 0)).toBe(true);
  });
});

describe("numbered systems", () => {
  it("numeric endnotes resetting per chapter resolve in document order", () => {
    const d = doc(
      [para("p1", ["One", "^1", " and two", "^2", "."])],
      [para("p2", ["Again one", "^1", "."], { page: 21 })],
      [{ label: "Notes", entries: ["1. A1.", "2. A2.", "1. B1.", "2. B2."] }],
    );
    const { refs, dest } = run(d);
    expect(refs.map(dest)).toEqual(["1. A1.", "2. A2.", "1. B1."]);
  });

  it("numeric footnotes pair with the same page", () => {
    const d = doc(
      [para("p1", ["Body text", "^1", " goes on", "^2", "."], { page: 3 }), para("f1", ["1 First footnote."], { page: 3 }), para("f2", ["2 Second footnote."], { page: 3 })],
      [],
    );
    const { refs, dest, systems } = run(d);
    expect(systems.some((s) => s.kind === "footnote")).toBe(true);
    expect(refs.map(dest)).toEqual(["1 First footnote.", "2 Second footnote."]);
  });

  it("tolerates the space extraction leaves inside brackets, keeping the brackets", () => {
    const d = doc([para("p1", ["Broken marker [ 3] in OCR text."], { prov: { page: 1, pages: [1], lines: 1, boxes: [], method: "ocr" } as never })], [], [{ label: "Notes", entries: NUMBERED }]);
    const { refs, text, dest } = run(d);
    expect(text(refs[0]!)).toBe("[ 3]");
    expect(dest(refs[0]!)).toBe("3. Note three.");
  });

  it("parenthesized numbers count only when the document numbers markers that way", () => {
    const seq = doc([para("p1", ["First claim(1), second claim(2), third claim(3)."])], [], [{ label: "Notes", entries: NUMBERED }]);
    expect(run(seq).refs.map(run(seq).text)).toEqual(["(1)", "(2)", "(3)"]);
    const lone = doc([para("p1", ["Pick option(2) from the list."])], [], [{ label: "Notes", entries: NUMBERED }]);
    expect(run(lone).refs).toHaveLength(0);
  });

  it("ordinary numbers, dates and exponents stay text", () => {
    const d = doc(
      [para("p1", ["In 1813, 20 guests paid 12 shillings; x", "^2", " + y = z and chapter 3 of his life."])],
      [],
      [{ label: "Notes", entries: NUMBERED }],
    );
    const { refs, recognition } = run(d);
    expect(refs).toHaveLength(0);
    expect(recognition.find((r) => r.text === "2")?.decision).toBe("rejected");
  });
});

describe("symbolic and lemma systems", () => {
  it("symbols and repeated symbols resolve independently, adjacent to punctuation", () => {
    const d = doc([para("p1", ["Alpha,* beta.** gamma†!"])], [], [{ label: "Notes", entries: ["* One.", "** Two.", "† Three.", "‡ Four."] }]);
    const { refs, text, dest } = run(d);
    expect(refs.map(text)).toEqual(["*", "**", "†"]);
    expect(refs.map(dest)).toEqual(["* One.", "** Two.", "† Three."]);
  });

  it("lemma-keyed notes anchor on exactly the quoted phrase", () => {
    const d = doc(
      [para("p1", ["They walked along the narrow ridge until noon."])],
      [],
      [{ label: "Notes", entries: ["“the narrow ridge”: a path.", "“a far hill”: x.", "“old mill”: y.", "“the ford”: z."] }],
    );
    const { refs, text } = run(d);
    expect(refs.filter((r) => r.to).map(text)).toEqual(["the narrow ridge"]);
  });
});

describe("textual and structural references", () => {
  it("navigates to an existing chapter only on evidence of intent", () => {
    const d = doc([para("p1", ["See Chapter 2 for more, unlike the first chapter of his life."])], [para("p2", ["x"])]);
    const { refs, text } = run(d);
    expect(refs.map(text)).toEqual(["Chapter 2"]);
    expect(refs[0]!.toSection).toBe("c2");
  });

  it("reference vocabulary in ordinary prose is never a reference", () => {
    const d = doc(
      [para("p1", ["The note on this argument is particularly interesting, and see how the book closes."])],
      [],
      [{ label: "Notes", entries: NUMBERED }],
    );
    const { refs, recognition } = run(d);
    expect(refs).toHaveLength(0);
    const r = recognition.find((x) => x.text.startsWith("note on"));
    expect(r?.decision).toBe("rejected");
  });

  it("keeps a cued reference to a missing destination as unresolved", () => {
    const d = doc([para("p1", ["See Chapter 9 for details."])], []);
    const { refs, text } = run(d);
    expect(refs.map(text)).toEqual(["Chapter 9"]);
    expect(refs[0]!.to ?? refs[0]!.toSection).toBeNull();
  });

  it("reports ambiguity instead of guessing between equal destinations", () => {
    const d = doc([para("p1", ["A note", "^2", "."])], [], [
      { label: "Notes", entries: NUMBERED },
      { label: "More Notes", entries: NUMBERED },
    ]);
    const { refs } = run(d);
    expect(refs[0]!.ambiguous).toBe(true);
  });
});

describe("several systems and references in one block", () => {
  it("keeps every reference independent with its own system and exact range", () => {
    const d = doc(
      [para("p1", ["Numbered", "^1", ", the author’s aside†, and see Chapter 2."])],
      [para("p2", ["x"])],
      [{ label: "Notes", entries: ["1. Ed one.", "2. Ed two.", "3. Ed three.", "* A.", "† B.", "‡ C."] }],
    );
    const { refs, text } = run(d);
    expect(refs.map(text)).toEqual(["1", "†", "Chapter 2"]);
    expect(new Set(refs.map((r) => r.system ?? r.type)).size).toBe(3);
    for (const r of refs) expect(r.marker.end - r.marker.start).toBe(text(r).length);
  });

  it("a reference split across PDF lines is matched on the reflowed text", () => {
    // the block text is already reflowed: the line break became a space
    const d = doc([para("p1", ["as discussed in", " Chapter", " 2 earlier."])], [para("p2", ["x"])]);
    const { refs, text } = run(d);
    expect(refs.map(text)).toEqual(["Chapter 2"]);
  });

  it("records a diagnostic decision for every candidate", () => {
    const d = doc([para("p1", ["A", "^1", " and the note on this point."])], [], [{ label: "Notes", entries: NUMBERED }]);
    const { recognition } = run(d);
    expect(recognition.length).toBeGreaterThanOrEqual(2);
    for (const r of recognition) {
      expect(["accepted", "accepted-unresolved", "merged", "rejected"]).toContain(r.decision);
      expect(r.reason).toBeTruthy();
      expect(r.signals.length).toBeGreaterThan(0);
    }
  });
});
