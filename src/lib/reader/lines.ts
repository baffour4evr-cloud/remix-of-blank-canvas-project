import type { RawItem, RawPage } from "./types";
import { fixGluedPunctuation } from "./unicode";

/**
 * Repair word spaces the extractor lost at punctuation boundaries, in place and
 * across run edges, so the runs and the line text stay in sync (a reference
 * range measured on the text must land on the same characters the reader
 * renders). Only ever inserts, never deletes.
 */
function respaceRuns(runs: LineRun[]): void {
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const nextCh = runs[i + 1]?.t[0] ?? "";
    const fixed = fixGluedPunctuation(run.t + nextCh);
    run.t = nextCh ? fixed.slice(0, fixed.length - 1) : fixed;
  }
}


export interface LineRun {
  t: string;
  f: string;
  s: number;
  x: number;
  sup: boolean;
  em: boolean;
  sc?: boolean;
  strong?: boolean;
  /** source page of the span this run came from (provenance only) */
  page?: number;
  /** reading-order index of the source span on its page (provenance only) */
  o?: number;
}

export interface Line {
  page: number;
  y: number;
  x: number;
  right: number;
  size: number;
  runs: LineRun[];
  text: string;
  /** vertical gap to the previous line on the same page */
  gap: number;
  furniture?: boolean;
}


function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Font id that covers the most characters on the page — treated as "roman". */
function dominantFont(items: RawItem[]): string {
  const counts = new Map<string, number>();
  for (const it of items) {
    if (!it.t.trim()) continue;
    counts.set(it.f, (counts.get(it.f) ?? 0) + it.t.length);
  }
  let best = "";
  let bestN = -1;
  for (const [f, n] of counts) {
    if (n > bestN) {
      best = f;
      bestN = n;
    }
  }
  return best;
}

/**
 * Group positioned text items into visual lines.
 *
 * Two passes: cluster by baseline, then fold small raised clusters (superscript
 * note markers such as `[2]` set 3pt above the baseline) back into the line they
 * belong to. Without the second pass every marker becomes a phantom line — and,
 * worse, a phantom *paragraph*, because it lands at the head of the next one.
 *
 * Word spacing is reconstructed from geometry rather than trusted: this class of
 * PDF frequently emits "want" and "of a wife" as adjacent spans with no space
 * character between them, which is where "Michaelmas,and" comes from.
 */
export function buildLines(page: RawPage): Line[] {
  const items = page.items.filter((i) => i.t !== "");
  if (!items.length) return [];
  const roman = dominantFont(items);
  const sorted = [...items].sort((a, b) => (Math.abs(a.y - b.y) > 1.5 ? b.y - a.y : a.x - b.x));

  interface Proto {
    y: number;
    size: number;
    items: RawItem[];
  }
  const protos: Proto[] = [];
  for (const it of sorted) {
    const last = protos[protos.length - 1];
    if (last && Math.abs(last.y - it.y) <= 1.6) {
      last.items.push(it);
      last.size = Math.max(last.size, it.s);
      continue;
    }
    protos.push({ y: it.y, size: it.s, items: [it] });
  }

  // Fold raised/small clusters into whichever full-size line they sit closest to.
  //
  // Superscript classification demands *baseline* evidence, not merely a smaller
  // font: a note marker is short, set above the host line's baseline, and works
  // inline with it. A whole passage set in a smaller face (a letter, a block
  // quote, an inserted document) also measures "small", but its lines sit on
  // their own baselines and run at full length, so they must stay ordinary
  // lines. Getting this wrong turns entire letters into superscript.
  const kept: Proto[] = [];
  const supIds = new Set<RawItem>();
  const bodySize = median(protos.map((p) => p.size));
  const textOf = (p: Proto) => p.items.map((i) => i.t).join("").trim();
  const isSmall = (p: Proto | undefined) => !!p && p.size < 0.9 * bodySize;
  for (let i = 0; i < protos.length; i++) {
    const p = protos[i]!;
    const prev = kept[kept.length - 1];
    const next = protos[i + 1];
    const body = textOf(p);
    // a run of consecutive small clusters is a small-font *region*, never a marker
    const inSmallRegion = isSmall(protos[i - 1]) && isSmall(next);
    const small =
      p.size < 0.9 * bodySize && p.items.length <= 4 && body.length <= 12 && !inSmallRegion;
    if (!small) {
      kept.push(p);
      continue;
    }
    // raised above the host baseline is what makes a span superscript
    const raisedPrev = prev ? p.y - prev.y : -Infinity;
    const raisedNext = next ? p.y - next.y : -Infinity;
    const dPrev = prev && raisedPrev > p.size * 0.1 ? Math.abs(prev.y - p.y) : Infinity;
    const dNext =
      next && next.size >= 0.9 * bodySize && raisedNext > p.size * 0.1 ? Math.abs(next.y - p.y) : Infinity;
    const host = dPrev <= dNext ? prev : next;
    const dist = Math.min(dPrev, dNext);
    if (!host || dist > bodySize * 1.1) {
      kept.push(p);
      continue;
    }
    for (const it of p.items) {
      supIds.add(it);
      host.items.push(it);
    }
  }


  const lines: Line[] = [];
  for (const p of kept) {
    const ordered = [...p.items].sort((a, b) => a.x - b.x);
    const runs: LineRun[] = [];
    let prevEnd: number | null = null;
    for (const it of ordered) {
      // reinstate a word space the encoder expressed as positioning only
      const gap = prevEnd == null ? 0 : it.x - prevEnd;
      const needsSpace =
        prevEnd != null &&
        gap > it.s * 0.14 &&
        !/\s$/.test(runs[runs.length - 1]?.t ?? "") &&
        !/^\s/.test(it.t);
      if (needsSpace) runs.push({ t: " ", f: it.f, s: it.s, x: it.x, sup: false, em: false });
      const run: LineRun = {
        t: it.t,
        f: it.f,
        s: it.s,
        x: it.x,
        sup: supIds.has(it),
        // Emphasis is a property of the font. When the extractor reports the
        // font's own style flags they are authoritative; only a producer that
        // reports none falls back to "not the dominant face".
        em:
          it.em != null || it.strong != null || it.sc != null
            ? !!it.em && !supIds.has(it)
            : it.f !== roman && !supIds.has(it) && !it.sc,
        page: page.page,
        ...(it.o != null ? { o: it.o } : {}),
      };
      if (it.sc) run.sc = true;
      if (it.strong) run.strong = true;
      runs.push(run);
      prevEnd = it.x + it.w;
    }
    respaceRuns(runs);
    const text = runs
      .map((r) => r.t)
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;
    const last = ordered[ordered.length - 1]!;
    lines.push({
      page: page.page,
      y: p.y,
      x: ordered[0]!.x,
      right: last.x + last.w,
      size: median(ordered.filter((i) => i.t.trim()).map((i) => i.s)) || p.size,
      runs,
      text,
      gap: 0,
    });
  }
  lines.sort((a, b) => b.y - a.y);
  for (let i = 1; i < lines.length; i++) lines[i]!.gap = lines[i - 1]!.y - lines[i]!.y;
  return lines;
}


export function modeOf(values: number[], round = 1): number {
  const counts = new Map<number, number>();
  for (const v of values) {
    const k = Math.round(v / round) * round;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = 0;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}
