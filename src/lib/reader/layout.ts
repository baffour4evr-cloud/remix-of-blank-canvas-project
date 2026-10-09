import { buildLines, modeOf, percentile, type Line } from "./lines";
import { planEngineFurniture } from "../engine/adapt";
import type { RawDoc } from "./types";

export interface DocProfile {
  bodySize: number;
  bodyIndent: number;
  /** left edge of ordinary prose — the measure justified lines are set to */
  proseLeft: number;
  paraIndent: number;
  maxRight: number;
  leading: number;
  headingSizes: number[];
}


export interface PageLines {
  page: number;
  width: number;
  height: number;
  lines: Line[];
}

/** A token removed from the reading text, kept so nothing is silently discarded. */
export interface RemovedToken {
  page: number;
  text: string;
  classification: "running-head" | "printed-page-number" | "repeated-boilerplate";
  confidence: number;
  reasonRemovedFromReadingText: string;
}

/** PDF page -> the page number printed on it, when the edition prints one. */
export interface PageMapEntry {
  pdfPage: number;
  printed: number;
  /** front matter numbered in Roman numerals is a separate sequence */
  roman: boolean;
}

/** Generic division heading shape — never furniture, however often it repeats. */
const STRUCTURAL_LINE = /^(book|volume|part|chapter|canto|act|section)\s+([0-9]+|[ivxlcdm]+|[a-z-]+)$/i;


export interface LayoutResult {
  pages: PageLines[];
  profile: DocProfile;
  dropped: number;
  /** every line taken out of the reading text, with why */
  removed: RemovedToken[];
  /** PDF page -> printed page number, recovered from the removed pagination */
  pageMap: PageMapEntry[];
}

export function layoutPages(doc: RawDoc): LayoutResult {
  const pages: PageLines[] = doc.pages.map((p) => ({
    page: p.page,
    width: p.width,
    height: p.height,
    lines: buildLines(p),
  }));

  const all = pages.flatMap((p) => p.lines);
  const long = all.filter((l) => l.text.length > 40);
  const bodySize = modeOf(long.map((l) => l.size), 0.5) || 12;
  const bodyIndent = modeOf(long.map((l) => l.x), 1);
  const maxRight = percentile(long.map((l) => l.right), 0.9);
  const leading = modeOf(
    all.filter((l) => l.gap > 2 && l.gap < 60).map((l) => l.gap),
    0.5,
  );

  // Prose measure: the left edge of the lines that fill the measure. Verse and
  // block quotes are indented past it, which is what separates them from prose.
  const fullLines = long.filter((l) => l.right >= maxRight - 8);
  const proseLeft = (fullLines.length > 20 ? modeOf(fullLines.map((l) => l.x), 1) : 0) || bodyIndent;

  // paragraph indent: the second most common left edge slightly right of body
  const indents = long
    .map((l) => Math.round(l.x))
    .filter((x) => x > bodyIndent + 4 && x < bodyIndent + 40);
  const paraIndent = indents.length > all.length * 0.02 ? modeOf(indents, 1) : bodyIndent + 12;

  const headingSizes = [
    ...new Set(
      all
        .filter((l) => l.size > bodySize * 1.12 && l.text.length < 90)
        .map((l) => Math.round(l.size * 2) / 2),
    ),
  ].sort((a, b) => b - a);

  // --- running heads / feet -------------------------------------------------
  // A line is furniture when its shape (normalized text + vertical position)
  // repeats across many pages. Position alone is unreliable: in both benchmark
  // PDFs the first body line sits at 93% of page height.
  const shapes = new Map<string, Line[]>();
  for (const p of pages) {
    for (const l of p.lines) {
      // Never treat a display-size line or a division heading as a running head:
      // "Book 1" recurs 24× at the same height but is the most important line
      // in the book.
      if (l.text.length > 70) continue;
      if (l.size > bodySize * 1.1) continue;
      if (STRUCTURAL_LINE.test(l.text)) continue;

      const key = `${l.text.replace(/\d+/g, "#").toLowerCase()}|${Math.round(l.y / 8)}`;
      const arr = shapes.get(key) ?? [];
      arr.push(l);
      shapes.set(key, arr);
    }
  }
  let dropped = 0;
  const removed: RemovedToken[] = [];
  const NUMERIC_ONLY = /^[\s.\-–—[\]()]*(\d{1,4}|[ivxlcdm]{1,7}|[IVXLCDM]{1,7})[\s.\-–—[\]()]*$/;
  const kill = (l: Line, classification: RemovedToken["classification"], reason: string, confidence: number) => {
    if (l.furniture) return;
    l.furniture = true;
    dropped++;
    removed.push({ page: l.page, text: l.text, classification, confidence, reasonRemovedFromReadingText: reason });
  };

  for (const [, group] of shapes) {
    if (group.length < Math.max(5, pages.length * 0.05)) continue;
    const numeric = group.every((l) => NUMERIC_ONLY.test(l.text));
    for (const l of group) {
      kill(
        l,
        numeric ? "printed-page-number" : "running-head",
        numeric
          ? `a bare numeral alone at the same page position on ${group.length} pages`
          : `identical short line at the same page position on ${group.length} pages`,
        Math.min(0.98, 0.6 + group.length / (pages.length * 4)),
      );
    }
  }
  // Position-independent boilerplate: a short line whose exact wording repeats
  // on a large share of pages is navigation or branding chrome, wherever it
  // sits. This subsumes converter artifacts (return-links, watermarks) without
  // knowing any of their wordings in advance.
  const repeats = new Map<string, Line[]>();
  for (const p of pages) {
    for (const l of p.lines) {
      if (l.furniture || l.text.length > 45 || l.size > bodySize * 1.1) continue;
      if (STRUCTURAL_LINE.test(l.text)) continue;
      const key = l.text.replace(/\d+/g, "#").toLowerCase();
      const arr = repeats.get(key) ?? [];
      arr.push(l);
      repeats.set(key, arr);
    }
  }
  for (const [, group] of repeats) {
    if (group.length < Math.max(8, pages.length * 0.08)) continue;
    const numeric = group.every((l) => NUMERIC_ONLY.test(l.text));
    for (const l of group) {
      kill(
        l,
        numeric ? "printed-page-number" : "repeated-boilerplate",
        `the same wording recurs on ${group.length} pages`,
        0.8,
      );
    }
  }

  // Sequence-based page numbers and locally repeating running heads (src/lib/engine).
  // Additive: lines removed above stay removed; this only catches what the exact-repeat
  // rules above miss (OCR-noisy numerals, misread digits, chapter-specific running heads).
  const enginePlan = planEngineFurniture(pages);
  for (const k of enginePlan.kills) {
    if (STRUCTURAL_LINE.test(k.line.text)) continue;
    kill(k.line, k.classification, k.reason, k.confidence);
  }

  // --- printed page map -----------------------------------------------------
  // The numerals just removed are the edition's own pagination. Keeping the
  // mapping is what lets "p. 6" resolve to the PDF page that prints 6 — front
  // matter in Roman numerals is a separate sequence and is kept apart.
  const pageMap: PageMapEntry[] = [];
  for (const r of removed) {
    if (r.classification !== "printed-page-number") continue;
    const token = r.text.replace(/[^0-9ivxlcdmIVXLCDM]/g, "");
    if (!token) continue;
    const arabic = /^\d+$/.test(token);
    const printed = arabic ? Number(token) : romanValue(token);
    if (printed == null || printed <= 0 || printed > 5000) continue;
    if (pageMap.some((e) => e.pdfPage === r.page)) continue;
    pageMap.push({ pdfPage: r.page, printed, roman: !arabic });
  }
  for (const e of enginePlan.pageMap) {
    const at = pageMap.findIndex((x) => x.pdfPage === e.pdfPage);
    if (at < 0) pageMap.push(e);
    else pageMap[at] = e; // the sequence-backed value corrects a misread numeral
  }
  pageMap.sort((a, b) => a.pdfPage - b.pdfPage);

  return {
    pages,
    profile: { bodySize, bodyIndent, proseLeft, paraIndent, maxRight, leading, headingSizes },
    dropped,
    removed,
    pageMap,
  };
}

function romanValue(s: string): number | null {
  const map: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const low = s.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(low)) return null;
  let total = 0;
  for (let i = 0; i < low.length; i++) {
    const v = map[low[i]!]!;
    const next = map[low[i + 1]!] ?? 0;
    total += v < next ? -v : v;
  }
  return total;
}


/** A page is verse when outdented numeric stichometry appears with short lines. */
export function isVersePage(p: PageLines, profile: DocProfile): boolean {
  const body = p.lines.filter((l) => !l.furniture && l.text.length > 2);
  if (body.length < 8) return false;
  const numbered = body.filter(
    (l) => l.x <= profile.bodyIndent - 15 && /^\d{1,4}\s+\S/.test(l.text),
  ).length;
  const short = body.filter((l) => l.right < profile.maxRight * 0.9).length;
  return numbered >= 1 && short / body.length > 0.4;
}
