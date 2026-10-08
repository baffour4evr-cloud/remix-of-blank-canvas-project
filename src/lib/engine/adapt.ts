// Adapter between the reader pipeline's Line type and the semantic engine.
// The engine never sees reader types; this file is the only place that knows both.

import type { PageLines } from "../reader/layout";
import type { Line } from "../reader/lines";
import { detectFurniture } from "./furniture.ts";
import type { ELine, EPage, EWord } from "./types.ts";
import { detectVerse } from "./verse.ts";

/** Set to false to restore the previous verse behaviour exactly. */
export const ENGINE_VERSE_GATE = true;

interface Adapted {
  pages: EPage[];
  lineOf: Map<ELine, Line>;
}

/** Words with estimated x-extents, taken from the real start of each run. */
function wordsOf(l: Line, top: number): EWord[] {
  const words: EWord[] = [];
  const runs = l.runs.filter((r) => r.t.trim() !== "");
  runs.forEach((r, k) => {
    const start = r.x;
    const next = runs[k + 1];
    const end = Math.max(start + 1, next ? next.x : l.right);
    const len = Math.max(1, r.t.length);
    for (const m of r.t.matchAll(/\S+/g)) {
      const at = m.index ?? 0;
      words.push({
        x0: start + (at / len) * (end - start),
        x1: start + ((at + m[0].length) / len) * (end - start),
        top,
        bottom: top + l.size,
        size: r.s || l.size,
        text: m[0],
      });
    }
  });
  return words;
}

function toEngine(pages: PageLines[], keep: (l: Line) => boolean): Adapted {
  const lineOf = new Map<ELine, Line>();
  const out: EPage[] = [];
  for (const p of pages) {
    const lines = p.lines.filter(keep);
    const topY = lines.length ? Math.max(...lines.map((l) => l.y)) : 0;
    const elines: ELine[] = [];
    for (const l of lines) {
      const top = topY - l.y; // PDF user space grows upward; the engine measures downward
      const words = wordsOf(l, top);
      if (!words.length) continue;
      const e: ELine = {
        page: l.page,
        x: l.x,
        right: l.right,
        top,
        bottom: top + l.size,
        size: l.size,
        text: l.text,
        words,
      };
      elines.push(e);
      lineOf.set(e, l);
    }
    out.push({ page: p.page, width: p.width, height: p.height, lines: elines });
  }
  return { pages: out, lineOf };
}

// ---------------------------------------------------------------------------
// Verse gate
// ---------------------------------------------------------------------------

export interface VerseGate {
  allows(l: Line): boolean;
  reason: string;
}

/**
 * The engine's verdict on which lines may be verse. It only ever VETOES:
 *  - nothing in the document counts as verse  -> no line may be verse;
 *  - verse proven by counting margin numbers  -> only lines inside the proven regions may be verse;
 *  - unnumbered verse only                    -> no gate (the existing zoning decides).
 */
export function verseGateFor(pages: PageLines[], em: number, leading: number): VerseGate | null {
  if (!ENGINE_VERSE_GATE) return null;
  const { pages: ep, lineOf } = toEngine(pages, (l) => !l.furniture);
  const flat = ep.flatMap((p) => p.lines);
  if (flat.length < 50) return null;
  const v = detectVerse(flat, { em, leading });
  if (v.regions.length === 0) {
    return { allows: () => false, reason: "no verse found: no counting margin numbers and no verse-like line evidence" };
  }
  if (!v.regions.some((r) => r.chains > 0)) return null;
  const allowed = new Set<Line>();
  flat.forEach((e, i) => {
    if (v.verse[i]) {
      const l = lineOf.get(e);
      if (l) allowed.add(l);
    }
  });
  return {
    allows: (l) => allowed.has(l),
    reason: `${v.chains.length} counting sequences of margin numbers prove verse in ${v.regions.length} region(s)`,
  };
}

// ---------------------------------------------------------------------------
// Furniture
// ---------------------------------------------------------------------------

export interface FurnitureKill {
  line: Line;
  classification: "printed-page-number" | "running-head";
  reason: string;
  confidence: number;
}

export interface FurniturePlan {
  kills: FurnitureKill[];
  pageMap: { pdfPage: number; printed: number; roman: boolean }[];
}

/** Page numbers and running heads found by sequence and local repetition. Plan only; nothing is mutated here. */
export function planEngineFurniture(pages: PageLines[]): FurniturePlan {
  const { pages: ep, lineOf } = toEngine(pages, () => true);
  const f = detectFurniture(ep);
  const kills: FurnitureKill[] = [];
  for (const h of f.hits) {
    const line = lineOf.get(h.line);
    if (!line) continue;
    kills.push({
      line,
      classification: h.kind === "page-number" ? "printed-page-number" : "running-head",
      reason: h.reason,
      confidence: h.kind === "page-number" ? 0.9 : 0.8,
    });
  }
  return { kills, pageMap: f.pageMap };
}
