// Page furniture: printed page numbers and running heads/feet.
//
// Page numbers are recognised by SEQUENCE, not by shape: a number is a page
// number only if it continues printed = page + offset across many pages. That
// is what lets a noisy OCR token such as "301 ;" still be recognised, and what
// stops a chapter numeral at the top of a page from being mistaken for one.
//
// Running heads are recognised by LOCAL REPETITION: a short line in the top or
// bottom band whose wording recurs on a neighbouring page (same page of the
// spread, or the facing one). That works for heads that change every chapter,
// which a global "repeats on 5% of pages" rule can never catch.

import type { ELine, EPage } from "./types.ts";
import { docEm } from "./types.ts";

export interface FurnitureHit {
  page: number;
  line: ELine;
  kind: "page-number" | "running-head";
  band: "top" | "bottom";
  reason: string;
  printed?: number;
  roman?: boolean;
}

export interface PageMapEntry { pdfPage: number; printed: number; roman: boolean }

export interface FurnitureResult {
  hits: FurnitureHit[];
  pageMap: PageMapEntry[];
  /** accepted offsets: printed = page + offset, with how many pages support each */
  offsets: { offset: number; roman: boolean; pages: number }[];
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function romanValue(s: string): number | null {
  const low = s.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(low)) return null;
  let total = 0;
  for (let i = 0; i < low.length; i++) {
    const v = ROMAN[low[i]!]!;
    const next = ROMAN[low[i + 1]!] ?? 0;
    total += v < next ? -v : v;
  }
  return total;
}

function parseNumber(text: string): { value: number; roman: boolean } | null {
  const t = text.trim();
  const a = t.match(/^[^\p{L}\p{N}]*(\d{1,4})[^\p{L}\p{N}]*$/u);
  if (a) return { value: Number(a[1]), roman: false };
  const r = t.match(/^[^\p{L}\p{N}]*([ivxlcdm]{1,7})[^\p{L}\p{N}]*$/iu);
  if (r) {
    const v = romanValue(r[1]!);
    if (v != null) return { value: v, roman: true };
  }
  return null;
}

/** true when a and b differ by at most one inserted, dropped or changed character */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

interface BandLine { page: number; band: "top" | "bottom"; line: ELine }

function bandLines(p: EPage): BandLine[] {
  const L = p.lines;
  const out: BandLine[] = [];
  L.slice(0, 2).forEach((line) => out.push({ page: p.page, band: "top", line }));
  L.slice(-2).forEach((line) => {
    if (!out.some((o) => o.line === line)) out.push({ page: p.page, band: "bottom", line });
  });
  return out;
}

export function detectFurniture(pages: EPage[]): FurnitureResult {
  const em = docEm(pages);
  const bands = pages.flatMap(bandLines);
  const minSupport = Math.max(4, Math.round(pages.length * 0.03));

  // --- page numbers: sequence fit -------------------------------------------
  const cands = bands
    .map((b) => ({ b, n: parseNumber(b.line.text) }))
    .filter((c): c is { b: BandLine; n: { value: number; roman: boolean } } => c.n != null);
  const groups = new Map<string, { offset: number; roman: boolean; pages: Set<number> }>();
  for (const c of cands) {
    const offset = c.n.value - c.b.page;
    const key = `${c.n.roman ? "r" : "a"}${offset}`;
    const g = groups.get(key) ?? { offset, roman: c.n.roman, pages: new Set<number>() };
    g.pages.add(c.b.page);
    groups.set(key, g);
  }
  // A sequence is real if it is long in total, or if it runs on four consecutive pages
  // (front matter is short; four pages in a row at one offset is not a coincidence).
  const longestRun = (pgs: Set<number>): number => {
    const s = [...pgs].sort((a, b) => a - b);
    let best = 1, run = 1;
    for (let i = 1; i < s.length; i++) {
      run = s[i]! - s[i - 1]! <= 2 ? run + 1 : 1;
      best = Math.max(best, run);
    }
    return s.length ? best : 0;
  };
  const accepted = [...groups.values()].filter((g) => g.pages.size >= minSupport || (g.pages.size >= 4 && longestRun(g.pages) >= 4));
  const hits: FurnitureHit[] = [];
  const taken = new Set<ELine>();
  const pageMap: PageMapEntry[] = [];

  for (const c of cands) {
    const g = accepted.find((a) => a.roman === c.n.roman && a.offset === c.n.value - c.b.page);
    if (!g) continue;
    taken.add(c.b.line);
    hits.push({
      page: c.b.page, line: c.b.line, kind: "page-number", band: c.b.band,
      reason: `continues the printed page sequence (printed = page ${g.offset >= 0 ? "+" : "−"} ${Math.abs(g.offset)}) on ${g.pages.size} pages`,
      printed: c.n.value, roman: c.n.roman,
    });
    pageMap.push({ pdfPage: c.b.page, printed: c.n.value, roman: c.n.roman });
  }
  // noisy tokens: the digits match the expected number and nothing else of substance is there
  for (const b of bands) {
    if (taken.has(b.line)) continue;
    const digits = b.line.text.match(/\d{1,4}/g);
    const letters = (b.line.text.match(/\p{L}/gu) ?? []).length;
    if (!digits || digits.length !== 1 || letters > 1 || b.line.words.length > 3) continue;
    const v = Number(digits[0]);
    const g = accepted.find((a) => !a.roman && a.offset === v - b.page);
    if (!g) continue;
    taken.add(b.line);
    hits.push({
      page: b.page, line: b.line, kind: "page-number", band: b.band,
      reason: `"${b.line.text}" is the expected number ${v} with stray marks (OCR noise)`,
      printed: v, roman: false,
    });
    pageMap.push({ pdfPage: b.page, printed: v, roman: false });
  }
  // a misread digit: one character away from the number the sequence says this page must carry
  for (const b of bands) {
    if (taken.has(b.line)) continue;
    const digits = b.line.text.match(/\d{1,4}/g);
    const letters = (b.line.text.match(/\p{L}/gu) ?? []).length;
    if (!digits || digits.length !== 1 || letters > 1 || b.line.words.length > 3) continue;
    const g = accepted.find((a) => !a.roman && withinOneEdit(digits[0]!, String(b.page + a.offset)));
    if (!g) continue;
    const expected = b.page + g.offset;
    taken.add(b.line);
    hits.push({
      page: b.page, line: b.line, kind: "page-number", band: b.band,
      reason: `"${b.line.text}" is one character from ${expected}, the number this page must carry (misread digit)`,
      printed: expected, roman: false,
    });
    pageMap.push({ pdfPage: b.page, printed: expected, roman: false });
  }

  // --- running heads: local repetition ---------------------------------------
  const numberLines = new Set(taken); // page numbers never vouch for, or count as, running heads
  const lineCount = new Map(pages.map((p) => [p.page, p.lines.length]));
  const byPage = new Map<number, BandLine[]>();
  for (const b of bands) byPage.set(b.page, [...(byPage.get(b.page) ?? []), b]);
  for (const b of bands) {
    if (numberLines.has(b.line) || (lineCount.get(b.page) ?? 0) < 8) continue; // title pages and blanks have no running head
    const t = b.line.text.trim();
    if (t.length < 3 || t.length > 70 || b.line.words.length > 10 || b.line.size > em * 1.25) continue;
    const key = norm(t);
    if (key.length < 3) continue;
    for (const d of [-2, -1, 1, 2]) {
      const other = byPage.get(b.page + d)?.find(
        (o) => o.band === b.band && !numberLines.has(o.line) && norm(o.line.text) === key,
      );
      if (other) {
        taken.add(b.line);
        hits.push({
          page: b.page, line: b.line, kind: "running-head", band: b.band,
          reason: `same wording recurs at the ${b.band} of page ${b.page + d}`,
        });
        break;
      }
    }
  }

  pageMap.sort((a, b) => a.pdfPage - b.pdfPage);
  hits.sort((a, b) => a.page - b.page);
  return {
    hits, pageMap,
    offsets: accepted.map((a) => ({ offset: a.offset, roman: a.roman, pages: a.pages.size })),
  };
}
