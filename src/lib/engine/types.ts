// Engine input model. Deliberately tiny and resolution-independent: every
// threshold in the engine is expressed in ems (the document's own text size),
// never in points or pixels, so a 180-dpi scan and a born-digital PDF behave alike.

export interface EWord { x0: number; x1: number; top: number; bottom: number; size: number; text: string }

export interface ELine {
  page: number;
  x: number;
  right: number;
  top: number;
  bottom: number;
  size: number;
  text: string;
  words: EWord[];
  italic?: boolean;
}

export interface EPage { page: number; width: number; height: number; lines: ELine[] }

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!;
};

export const mode = (xs: number[], bin = 1): number => {
  const c = new Map<number, number>();
  for (const x of xs) {
    const k = Math.round(x / bin) * bin;
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  let best = 0, bk = 0;
  for (const [k, v] of c) if (v > best) { best = v; bk = k; }
  return bk;
};

/** The document's text size: median size of lines long enough to be running text. */
export function docEm(pages: EPage[]): number {
  return median(pages.flatMap((p) => p.lines.filter((l) => l.text.length > 30).map((l) => l.size))) || 12;
}

/** Typical distance between consecutive lines of running text, in the page's own units. */
export function docLeading(pages: EPage[]): number {
  const gaps: number[] = [];
  for (const p of pages) {
    for (let i = 1; i < p.lines.length; i++) {
      const g = p.lines[i]!.top - p.lines[i - 1]!.top;
      if (g > 0) gaps.push(g);
    }
  }
  const typical = median(gaps) || 12; // computed once, not once per line
  return median(gaps.filter((g) => g < 4 * typical)) || 14;
}
