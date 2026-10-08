import { describe, expect, it } from "vitest";

import { detectApparatus } from "@/lib/reader/apparatus";
import { detectPageNotes } from "@/lib/reader/footnotes";
import { buildReferences, type PageLink } from "@/lib/reader/references";
import type { Block, RefEdge, Run, StructureNode } from "@/lib/reader/types";

// Synthetic documents only: no book, title or phrase is known to the engine.

/** "^x" parts are superscript runs */
function para(id: string, parts: string[], over: Partial<Block> = {}): Block {
  const runs: Run[] = parts.map((p) => (p.startsWith("^") ? { t: p.slice(1), sup: true } : { t: p }));
  return { id, page: 1, type: "paragraph", section: "body", runs, text: runs.map((r) => r.t).join(""), ...over };
}

interface Doc {
  blocks: Block[];
  structure: StructureNode[];
}

/** body paragraphs, then one notes section per entry list */
function doc(body: Block[], notes: { label: string; entries: string[] }[]): Doc {
  const blocks: Block[] = [...body];
  const structure: StructureNode[] = [
    { id: "root", type: "root", label: "", number: null, title: "", page: 1, parent: null, depth: 0, start: 0, end: 0 },
    { id: "body", type: "chapter", label: "Chapter 1", number: 1, title: "", page: 1, parent: "root", depth: 1, start: 0, end: body.length },
  ];
  notes.forEach((n, k) => {
    const start = blocks.length;
    n.entries.forEach((t, i) => blocks.push(para(`n${k}_${i}`, [t], { section: `notes${k}`, page: 50 + k })));
    structure.push({
      id: `notes${k}`,
      type: "apparatus",
      label: n.label,
      number: null,
      title: n.label,
      page: 50 + k,
      parent: "root",
      depth: 1,
      start,
      end: blocks.length,
    });
  });
  structure[0]!.end = blocks.length;
  return { blocks, structure };
}

function run(d: Doc, links: PageLink[] = []) {
  const { systems, entries } = detectApparatus(d.blocks, d.structure, false);
  const page = detectPageNotes(d.blocks, d.structure, systems.length);
  systems.push(...page.systems);
  entries.push(...page.entries);
  const { refs, unresolved } = buildReferences(d.blocks, d.structure, systems, entries, { links });
  const text = (r: RefEdge) => d.blocks.find((b) => b.id === r.from)!.text.slice(r.marker.start, r.marker.end);
  const dest = (r: RefEdge) => d.blocks.find((b) => b.id === r.to)?.text ?? null;
  return { systems, refs, unresolved, text, dest };
}

const SYMBOL_NOTES = ["* First symbol note.", "† Second symbol note.", "‡ Third symbol note.", "§ Fourth symbol note."];

describe("non-numeric reference markers", () => {
  it("resolves a single-symbol note on exactly the symbol", () => {
    const d = doc([para("p1", ["The house was large", "^*", " and very old."])], [{ label: "Notes", entries: SYMBOL_NOTES }]);
    const { refs, text, dest, systems } = run(d);
    expect(refs).toHaveLength(1);
    expect(text(refs[0]!)).toBe("*");
    expect(dest(refs[0]!)).toBe("* First symbol note.");
    expect(systems.find((s) => s.id === refs[0]!.system)?.grammar).toBe("symbol");
  });

  it("keeps repeated symbols distinct from the single symbol", () => {
    const d = doc(
      [para("p1", ["One", "^*", " and two", "^**", " and three", "^††", "."])],
      [{ label: "Notes", entries: ["* Single.", "** Double star.", "† Dagger.", "†† Double dagger."] }],
    );
    const { refs, text, dest } = run(d);
    expect(refs.map(text)).toEqual(["*", "**", "††"]);
    expect(refs.map(dest)).toEqual(["* Single.", "** Double star.", "†† Double dagger."]);
  });

  it("resolves alphabetic notes", () => {
    const d = doc(
      [para("p1", ["A claim", "^a", " and another", "^c", "."])],
      [{ label: "Notes", entries: ["a. Letter a.", "b. Letter b.", "c. Letter c.", "d. Letter d."] }],
    );
    const { refs, text, dest } = run(d);
    expect(refs.map(text)).toEqual(["a", "c"]);
    expect(refs.map(dest)).toEqual(["a. Letter a.", "c. Letter c."]);
  });

  it("resolves Roman-numeral notes", () => {
    const d = doc(
      [para("p1", ["Early", "^ii", " and later", "^iv", "."])],
      [{ label: "Notes", entries: ["i. One.", "ii. Two.", "iii. Three.", "iv. Four."] }],
    );
    const { refs, text, dest, systems } = run(d);
    expect(refs.map(text)).toEqual(["ii", "iv"]);
    expect(refs.map(dest)).toEqual(["ii. Two.", "iv. Four."]);
    expect(systems[0]!.grammar).toBe("roman");
  });

  it("anchors unnumbered endnotes on the phrase they quote", () => {
    const d = doc(
      [para("p1", ["She crossed the silver bridge at dawn and waited."])],
      [
        {
          label: "Notes",
          entries: [
            "“the silver bridge”: an old crossing.",
            "“at dusk”: evening.",
            "“the long road”: a route.",
            "“green hills”: farmland.",
          ],
        },
      ],
    );
    const { refs, text, dest } = run(d);
    const r = refs.find((x) => x.to)!;
    expect(text(r)).toBe("the silver bridge");
    expect(dest(r)).toBe("“the silver bridge”: an old crossing.");
  });
});

describe("simultaneous note systems", () => {
  it("splits one notes section into independent numbered and symbol systems", () => {
    const d = doc(
      [para("p1", ["Numbered", "^1", " and the author’s aside†, then numbered again", "^2", "."])],
      [
        {
          label: "Notes",
          entries: ["1. Editor one.", "2. Editor two.", "3. Editor three.", "* Author star.", "† Author dagger.", "‡ Author double."],
        },
      ],
    );
    const { refs, text, dest, systems } = run(d);
    expect(refs.map(text)).toEqual(["1", "†", "2"]);
    expect(refs.map(dest)).toEqual(["1. Editor one.", "† Author dagger.", "2. Editor two."]);
    const ids = new Set(refs.map((r) => r.system));
    expect(ids.size).toBe(2);
    expect(systems.filter((s) => ids.has(s.id)).map((s) => s.grammar).sort()).toEqual(["sequential", "symbol"]);
  });

  it("keeps separately headed systems apart even when keys collide", () => {
    const d = doc(
      [para("p1", ["Here", "^*", " and here", "^1", "."])],
      [
        { label: "Translator’s Notes", entries: ["1. T one.", "2. T two.", "3. T three.", "4. T four."] },
        { label: "Author’s Notes", entries: SYMBOL_NOTES },
      ],
    );
    const { refs, systems } = run(d);
    const star = refs.find((r) => r.key === "*")!;
    const one = refs.find((r) => r.key === "1")!;
    expect(star.system).not.toBe(one.system);
    expect(one.type).toBe("translator-note");
    expect(star.type).toBe("author-note");
    expect(systems.length).toBe(2);
  });

  it("keeps several symbols in one paragraph independent", () => {
    const d = doc(
      [para("p1", ["Alpha*, beta†, and gamma‡ all differ."])],
      [{ label: "Notes", entries: SYMBOL_NOTES }],
    );
    const { refs, text, dest } = run(d);
    expect(refs.map(text)).toEqual(["*", "†", "‡"]);
    expect(refs.map((r) => r.marker.end - r.marker.start)).toEqual([1, 1, 1]);
    expect(refs.map(dest)).toEqual(SYMBOL_NOTES.slice(0, 3));
  });
});

describe("evidence requirements", () => {
  it("does not treat ordinary punctuation as markers", () => {
    const d = doc(
      [
        para("p1", ["5 * 3 equals fifteen, and * * * marks a break."]),
        para("p2", ["The 2", "^e", " arrondissement, Mlle Dupont, and section § 4 of the act."]),
        para("p3", ["A dagger† with no note system at all."]),
      ],
      [],
    );
    expect(run(d).refs).toHaveLength(0);
  });

  it("does not treat a glued symbol as a marker when no system prints that symbol", () => {
    const d = doc(
      [para("p1", ["Stars* everywhere, but only numbered notes", "^1", "."])],
      [{ label: "Notes", entries: ["1. One.", "2. Two.", "3. Three.", "4. Four."] }],
    );
    const { refs, text } = run(d);
    expect(refs.map(text)).toEqual(["1"]);
  });

  it("keeps a typographic marker with no destination as an unresolved candidate", () => {
    const d = doc([para("p1", ["A raised dagger", "^‡", " and nothing else."])], [{ label: "Notes", entries: ["* a.", "† b.", "** c.", "†† d."] }]);
    const { refs, text, unresolved } = run(d);
    expect(refs).toHaveLength(1);
    expect(text(refs[0]!)).toBe("‡");
    expect(refs[0]!.to).toBeNull();
    expect(refs[0]!.method).toBe("unresolved");
    expect(unresolved.length).toBe(1);
  });
});

describe("markers near boundaries", () => {
  it("anchors a marker at the end of a paragraph and pairs page footnotes", () => {
    const body = [
      para("p1", ["The first page ends here.†"], { page: 3 }),
      para("p2", ["† A footnote printed at the foot of the page."], { page: 3 }),
      para("p3", ["Next page opens", "^*", " with another."], { page: 4 }),
      para("p4", ["* The second footnote."], { page: 4 }),
    ];
    const d = doc(body, []);
    const { refs, text, dest, systems } = run(d);
    expect(systems[0]!.kind).toBe("footnote");
    expect(refs.map(text)).toEqual(["†", "*"]);
    expect(refs.map(dest)).toEqual(["† A footnote printed at the foot of the page.", "* The second footnote."]);
    // the marker is the last character and nothing beyond it
    const r = refs.find((x) => x.from === "p1")!;
    expect(r.marker.end).toBe(body[0]!.text.length);
    expect(r.marker.end - r.marker.start).toBe(1);
  });

  it("does not pair a marker-shaped paragraph with no inline caller", () => {
    const d = doc([para("p1", ["Plain text."], { page: 3 }), para("p2", ["* A lone starred line."], { page: 3 })], []);
    const { refs, systems } = run(d);
    expect(systems).toHaveLength(0);
    expect(refs).toHaveLength(0);
  });

  it("resolves sequential keys restarting per chapter in document order", () => {
    const d = doc(
      [
        para("p1", ["First chapter note", "^1", "."]),
        para("p2", ["Second chapter note", "^1", "."]),
      ],
      [{ label: "Notes", entries: ["1. Chapter one, note one.", "2. Chapter one, note two.", "1. Chapter two, note one.", "2. Chapter two, note two."] }],
    );
    const { refs, dest } = run(d);
    expect(refs.map(dest)).toEqual(["1. Chapter one, note one.", "1. Chapter two, note one."]);
  });
});

describe("explicit link destinations", () => {
  const box = (page: number, y: number) => ({ page, pages: [page], lines: 1, boxes: [{ page, x: 50, y, w: 300, h: 15 }] });
  const linked = () => {
    const d = doc([para("p1", ["A word[2] here."], { page: 1, prov: box(1, 700) })], []);
    d.blocks.push(
      { ...para("h", ["CHAPTER TWO"], { page: 9, prov: box(9, 714) }), type: "heading" },
      { ...para("e1", ["1. Note one."], { page: 9, prov: box(9, 694) }), type: "entry", key: "1" },
      { ...para("e2", ["2. Note two."], { page: 9, prov: box(9, 650) }), type: "entry", key: "2" },
      { ...para("e3", ["3. Note three."], { page: 10, prov: box(10, 740) }), type: "entry", key: "3" },
    );
    return d;
  };
  const link = (destY: number, text: string, destPage = 9): PageLink => ({
    page: 1, x: 100, y: 700, w: 20, h: 15, destPage, destY, url: null, text,
  });

  it("lands on the note beneath the point, not the heading above it", () => {
    const d = linked();
    d.blocks[0] = para("p1", ["A word[1] here."], { page: 1, prov: box(1, 700) });
    const { refs, dest, text } = run(d, [link(705, "[1]")]);
    expect(text(refs[0]!)).toBe("[1]");
    expect(dest(refs[0]!)).toBe("1. Note one.");
  });

  it("prefers the nearby entry carrying the linked marker's key", () => {
    const d = linked();
    d.blocks[0] = para("p1", ["A word[2] here."], { page: 1, prov: box(1, 700) });
    const { refs, dest, text } = run(d, [link(712, "[2]")]);
    expect(text(refs[0]!)).toBe("[2]");
    expect(dest(refs[0]!)).toBe("2. Note two.");
  });

  it("continues onto the next page when the point lies below all content", () => {
    const d = linked();
    d.blocks[0] = para("p1", ["A word[3] here."], { page: 1, prov: box(1, 700) });
    const { refs, dest } = run(d, [link(40, "[3]")]);
    expect(dest(refs[0]!)).toBe("3. Note three.");
  });
});
