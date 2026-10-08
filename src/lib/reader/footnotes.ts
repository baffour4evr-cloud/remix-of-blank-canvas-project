// Notes printed in the running text's own pages (footnotes), discovered from
// paired evidence rather than from any marker shape alone.
//
// A body paragraph that opens with a marker ("* The author means…",
// "a. Literally…", "† See…") is a note only when an earlier paragraph on the
// same or the preceding page carries the *same* marker as a superscript or as a
// symbol glued to a word. A symbol on its own proves nothing; the pair does.

import type { ApparatusEntry } from "./apparatus";
import { matchEntry } from "./apparatus";
import { GLUED_SYMBOL, markerClass, markerKey, type MarkerClass } from "./markers";
import { isProse, type Block, type RefSystem, type StructureNode } from "./types";

/** Markers a body paragraph prints inline, with typographic evidence attached. */
export function inlineMarkerKeys(b: Block): { key: string; sup: boolean }[] {
  const out: { key: string; sup: boolean }[] = [];
  for (const r of b.runs) {
    if (!r.sup) continue;
    const key = markerKey(r.t);
    if (markerClass(key)) out.push({ key, sup: true });
  }
  for (const m of b.text.matchAll(GLUED_SYMBOL)) out.push({ key: m[1]!, sup: false });
  return out;
}

const LABEL: Record<MarkerClass, string> = {
  numeric: "Footnotes (numbered)",
  symbol: "Footnotes (symbols)",
  alphabetic: "Footnotes (lettered)",
  roman: "Footnotes (roman numerals)",
};

export function detectPageNotes(
  blocks: Block[],
  structure: StructureNode[],
  firstId: number,
): { systems: RefSystem[]; entries: ApparatusEntry[] } {
  const byId = new Map(structure.map((s) => [s.id, s]));
  const inApparatus = (sectionId: string) => {
    let cur = byId.get(sectionId);
    while (cur) {
      if (cur.type === "apparatus" || cur.type === "appendix") return true;
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return false;
  };

  // markers printed in running text, indexed by page
  const markersByPage = new Map<number, { i: number; key: string }[]>();
  blocks.forEach((b, i) => {
    if (!isProse(b.type) && b.type !== "verse-line") return;
    if (inApparatus(b.section)) return;
    for (const m of inlineMarkerKeys(b)) {
      const arr = markersByPage.get(b.page) ?? [];
      arr.push({ i, key: m.key });
      markersByPage.set(b.page, arr);
    }
  });
  if (!markersByPage.size) return { systems: [], entries: [] };

  const found = new Map<MarkerClass, { b: Block; key: string; evidence: string }[]>();
  blocks.forEach((b, i) => {
    if (!isProse(b.type) || b.type === "list-item" || inApparatus(b.section)) return;
    const m = matchEntry(b);
    if (!m) return;
    const key = markerKey(m.key);
    const cls = markerClass(key);
    if (!cls || cls === "numeric" && !/^\d{1,3}$/.test(key)) return;
    const caller = [...(markersByPage.get(b.page) ?? []), ...(markersByPage.get(b.page - 1) ?? [])].find(
      (c) => c.key === key && c.i < i,
    );
    if (!caller) return;
    const arr = found.get(cls) ?? [];
    arr.push({ b, key, evidence: `marker "${key}" printed inline in ${blocks[caller.i]!.id} on page ${blocks[caller.i]!.page}` });
    found.set(cls, arr);
  });

  const systems: RefSystem[] = [];
  const entries: ApparatusEntry[] = [];
  let n = firstId;
  for (const [cls, arr] of found) {
    // a single numbered pair is too weak to found a system; a symbol pair is not
    if (cls !== "symbol" && arr.length < 2) continue;
    const id = `sys${n++}`;
    systems.push({
      id,
      kind: "footnote",
      label: LABEL[cls],
      grammar: cls === "symbol" ? "symbol" : cls === "roman" ? "roman" : cls === "alphabetic" ? "alphabetic" : "sequential",
      keyScope: "section",
      hosts: [],
      typography: { size: 0, indent: 0, leading: 0, altFontLemma: false },
      entryCount: arr.length,
      evidence: [
        `${arr.length} paragraph(s) in the running text open with a ${cls} marker`,
        "each is paired with the same marker printed inline earlier on the same or preceding page",
      ],
      confidence: Math.min(0.95, 0.6 + arr.length * 0.05),
      samples: arr.slice(0, 3).map((x) => ({ key: x.key, text: x.b.text.slice(0, 160) })),
    });
    for (const x of arr) {
      x.b.type = "entry";
      x.b.system = id;
      x.b.key = x.key;
      entries.push({ blockId: x.b.id, system: id, key: x.key, numeric: null, lemma: null, section: x.b.section });
    }
  }
  return { systems, entries };
}
