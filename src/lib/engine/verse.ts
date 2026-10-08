// Verse detection as a two-state sequence labelling problem (prose / verse).
//
// No decision depends on absolute page coordinates, so scan drift and page size
// cannot create or hide verse. Each line contributes evidence that is
// independent of the others, a smoothing pass (Viterbi) turns the evidence into
// contiguous regions, and a number in the margin only counts when it belongs to
// a real counting sequence (5, 10, 15 … or 1, 2, 3 …).

import type { ELine } from "./types.ts";
import { mode, quantile } from "./types.ts";

const TERMINAL = /[.!?…]["”’')\]]*\s*$/;
const ANY_END = /[,.;:!?—–”’)\]]["”’')\]]*\s*$/;
const HYPHEN_END = /\p{L}-\s*$/u;

export interface MarginNumber { idx: number; n: number; side: "left" | "right" }
export interface NumberChain { side: "left" | "right"; step: number; idxs: number[]; ns: number[] }

export interface VerseRegion {
  start: number;
  end: number;
  lines: number;
  /** body-line indices that are wrapped continuations of the previous verse line */
  turnovers: number[];
  /** how many of the lines whose previous line did not end a sentence open with a capital */
  capRate: number | null;
  /** number of line breaks the capital-start rate was measured on */
  capSample: number;
  /** share of lines carrying a 3+ digit number (years, ISBNs, page ranges): records, not verse */
  recordRate: number;
  /** share of lines that end in punctuation: verse in sentence diction does, catalogue entries do not */
  endPunctRate: number;
  chains: number;
  /** consecutive numbered lines whose spacing equals the numeric step once turnovers are excluded */
  consistency: { pairs: number; ok: number };
  /** why the region is verse, in plain words */
  evidence: string[];
}

export interface VerseResult {
  verse: Uint8Array;
  regions: VerseRegion[];
  chains: NumberChain[];
  margin: MarginNumber[];
}

/** "upper" | "lower" for a normally capitalised or lower-case first word; null when it tells us nothing (ALL CAPS, quotes, digits). */
function initialKind(text: string): "upper" | "lower" | null {
  const w = text.match(/^(\p{L}[\p{L}'’]*)/u)?.[1];
  if (!w) return null;
  if (w.length >= 2 && w === w.toUpperCase()) return null; // headings and labels, not line-initial capitals
  return w[0] !== w[0]!.toLowerCase() ? "upper" : "lower";
}
const LIST_ITEM = /^\(?\d{1,3}[.)\]]\s+\S/;

/**
 * A numeral hung in the margin of a line. Two printings are recognised: a clear
 * gap between the numeral and the text, or (common once a PDF is flowed from an
 * ebook) a numeral that is part of the same run but pushes the line's start
 * out beyond where its neighbours begin.
 */
function marginNumber(l: ELine, em: number, neighbourStart: number | null): { n: number; side: "left" | "right" } | null {
  const w = l.words;
  if (w.length < 3) return null;
  const f = w[0]!;
  if (/^\d{1,4}$/.test(f.text)) {
    if (w[1]!.x0 - f.x1 >= 0.9 * em) return { n: Number(f.text), side: "left" };
    if (neighbourStart != null && l.x <= neighbourStart - 0.9 * em) return { n: Number(f.text), side: "left" };
  }
  const last = w[w.length - 1]!;
  const pen = w[w.length - 2]!;
  if (/^\d{1,4}$/.test(last.text) && last.x0 - pen.x1 >= 0.9 * em) return { n: Number(last.text), side: "right" };
  return null;
}

function validateChains(cands: MarginNumber[]): NumberChain[] {
  const chains: NumberChain[] = [];
  const open: Record<string, NumberChain | null> = { left: null, right: null };
  const tmp = new WeakMap<NumberChain, { step: number | null }>();
  for (const c of cands) {
    const ch = open[c.side];
    if (ch) {
      const st = tmp.get(ch)!;
      const dn = c.n - ch.ns[ch.ns.length - 1]!;
      const di = c.idx - ch.idxs[ch.idxs.length - 1]!;
      const stepOk = st.step == null ? [1, 5, 10].includes(dn) : dn === st.step;
      // spacing in lines must match the numeric step (turnovers only ever add lines)
      if (stepOk && di >= dn * 0.9 && di <= dn * 1.8) {
        st.step ??= dn;
        ch.step = st.step;
        ch.idxs.push(c.idx);
        ch.ns.push(c.n);
        continue;
      }
    }
    const nc: NumberChain = { side: c.side, step: 0, idxs: [c.idx], ns: [c.n] };
    tmp.set(nc, { step: null });
    chains.push(nc);
    open[c.side] = nc;
  }
  return chains.filter((c) => c.idxs.length >= 3 && c.step > 0);
}

export interface VerseOptions { em: number; leading: number; switchPenalty?: number }

export function detectVerse(lines: ELine[], opt: VerseOptions): VerseResult {
  const { em, leading } = opt;
  const switchPenalty = opt.switchPenalty ?? 6;
  const n = lines.length;

  // 1. margin numerals, kept only when they form a counting sequence
  const margin: MarginNumber[] = [];
  const marginOf = new Map<number, { n: number; side: "left" | "right" }>();
  const startsAround = (idx: number): number | null => {
    const xs: number[] = [];
    for (let k = Math.max(0, idx - 4); k <= Math.min(n - 1, idx + 4); k++) {
      if (k === idx || lines[k]!.page !== lines[idx]!.page) continue;
      if (/^\d{1,4}$/.test(lines[k]!.words[0]?.text ?? "")) continue;
      xs.push(lines[k]!.x);
    }
    if (xs.length < 3) return null;
    xs.sort((a, b) => a - b);
    return xs[xs.length >> 1]!;
  };
  lines.forEach((l, idx) => {
    const m = marginNumber(l, em, startsAround(idx));
    if (m) { margin.push({ idx, ...m }); marginOf.set(idx, m); }
  });
  const chains = validateChains(margin);
  const inChain = new Set<number>();
  const numbered = new Uint8Array(n);
  for (const c of chains) {
    c.idxs.forEach((i) => inChain.add(i));
    const lo = Math.max(0, c.idxs[0]! - Math.min(c.step, 12));
    const hi = Math.min(n - 1, c.idxs[c.idxs.length - 1]! + Math.min(c.step, 12));
    for (let i = lo; i <= hi; i++) numbered[i] = 1;
  }

  // the text of a line without its margin numeral
  const cleanText = (i: number): string => {
    const l = lines[i]!;
    const m = marginOf.get(i);
    if (!m || !inChain.has(i)) return l.text;
    const ws = m.side === "left" ? l.words.slice(1) : l.words.slice(0, -1);
    return ws.map((w) => w.text).join(" ");
  };
  const hasHungNumber = (i: number) => inChain.has(i) && marginOf.get(i)?.side === "left";
  const startX = (i: number): number => lines[i]!.x;

  // 2. per-line evidence (log-likelihood ratio, verse : prose)
  const llr = new Float64Array(n);
  let capHits = 0, capTotal = 0;
  for (let i = 0; i < n; i++) {
    let s = -0.1; // occupying the verse state costs a little: neutral stretches stay prose
    if (i > 0) {
      const prev = lines[i - 1]!, cur = lines[i]!;
      const samePage = prev.page === cur.page;
      const consecutive = !samePage || cur.top - prev.top <= 1.7 * leading;
      const prevText = cleanText(i - 1);
      if (consecutive) {
        if (HYPHEN_END.test(prevText) && !/[-–—]{2}$/.test(prevText)) s -= 3.5; // wrapped prose
        // a line break only says something when the previous line was a real wrapped unit
        if (!TERMINAL.test(prevText) && lines[i - 1]!.words.length >= 4) {
          const k = initialKind(cleanText(i));
          if (k) {
            capTotal++;
            if (k === "upper") { s += 2.5; capHits++; } else s -= 2.2;
          }
        }
      }
      if (LIST_ITEM.test(cleanText(i))) s -= 1.5; // numbered notes and list entries are prose
    }
    if (numbered[i]) s += 3;
    llr[i] = s;
  }

  // 3. Viterbi smoothing
  const score = [new Float64Array(n), new Float64Array(n)];
  const back = [new Int8Array(n), new Int8Array(n)];
  score[0]![0] = 0;
  score[1]![0] = llr[0]! - switchPenalty;
  for (let i = 1; i < n; i++) {
    for (const s of [0, 1]) {
      const stay = score[s]![i - 1]!;
      const swap = score[1 - s]![i - 1]! - switchPenalty;
      const best = stay >= swap ? stay : swap;
      back[s]![i] = stay >= swap ? s : 1 - s;
      score[s]![i] = best + (s === 1 ? llr[i]! : 0);
    }
  }
  const verse = new Uint8Array(n);
  let st = score[1]![n - 1]! > score[0]![n - 1]! ? 1 : 0;
  for (let i = n - 1; i >= 0; i--) {
    verse[i] = st;
    st = back[st]![i]!;
  }

  // 4. regions with their own evidence
  const regions: VerseRegion[] = [];
  let i = 0;
  while (i < n) {
    if (!verse[i]) { i++; continue; }
    let j = i;
    while (j < n && verse[j]) j++;
    const r = j - i >= 4 ? describe(i, j - 1) : null;
    // a region is verse only on real evidence: a counting sequence of margin
    // numbers, or enough mid-sentence line breaks that overwhelmingly start with a capital
    const proven =
      r != null &&
      (r.chains > 0 || (r.capRate != null && r.capRate >= 0.85 && r.capSample >= 10 && r.recordRate < 0.2 && r.endPunctRate >= 0.35));
    if (r && proven) regions.push(r);
    else for (let k = i; k < j; k++) verse[k] = 0;
    i = j;
  }

  function describe(start0: number, end0: number): VerseRegion {
    // a region proven by counting sequences is exactly as long as the sequences say, plus the
    // lines that precede the first numeral and follow the last one
    let start = start0, end = end0;
    const inside = chains.filter((c) => c.idxs[0]! >= start0 && c.idxs[c.idxs.length - 1]! <= end0);
    if (inside.length) {
      const pad = (c: NumberChain) => Math.min(c.step, 12) + 4;
      start = Math.max(start0, Math.min(...inside.map((c) => c.idxs[0]! - pad(c))));
      end = Math.min(end0, Math.max(...inside.map((c) => c.idxs[c.idxs.length - 1]! + pad(c))));
      for (let k = start0; k < start; k++) verse[k] = 0;
      for (let k = end + 1; k <= end0; k++) verse[k] = 0;
    }
    const idxs = Array.from({ length: end - start + 1 }, (_, k) => start + k);
    const starts = idxs.filter((k) => !hasHungNumber(k)).map(startX);
    const modeStart = mode(starts, Math.max(1, 0.3 * em));
    const rightEdge = quantile(idxs.map((k) => lines[k]!.right), 0.9);
    const turnovers: number[] = [];
    for (let k = start + 1; k <= end; k++) {
      const l = lines[k]!, p = lines[k - 1]!;
      if (hasHungNumber(k)) continue; // a numbered line begins a verse line; it is never a wrap
      const sx = startX(k);
      if (
        sx - modeStart > 0.5 * em &&
        l.right - sx < 0.45 * (rightEdge - modeStart) &&
        p.right >= rightEdge - 4 * em
      ) turnovers.push(k);
    }
    const turn = new Set(turnovers);
    let ch = 0, pairs = 0, ok = 0;
    for (const c of chains) {
      if (c.idxs[0]! < start || c.idxs[c.idxs.length - 1]! > end) continue;
      ch++;
      for (let a = 1; a < c.idxs.length; a++) {
        pairs++;
        let count = 0;
        for (let k = c.idxs[a - 1]! + 1; k <= c.idxs[a]!; k++) if (!turn.has(k)) count++;
        if (count === c.ns[a]! - c.ns[a - 1]!) ok++;
      }
    }
    let ct = 0, cc = 0;
    for (let k = start + 1; k <= end; k++) {
      if (TERMINAL.test(cleanText(k - 1)) || lines[k - 1]!.words.length < 4) continue;
      const kind = initialKind(cleanText(k));
      if (!kind) continue;
      ct++;
      if (kind === "upper") cc++;
    }
    const capRate = ct >= 4 ? cc / ct : null;
    const withNumber = idxs.filter((k) => /\d{3,}/.test(cleanText(k))).length;
    const recordRate = withNumber / idxs.length;
    const endPunctRate = idxs.filter((k) => ANY_END.test(cleanText(k))).length / idxs.length;
    const evidence: string[] = [];
    if (capRate != null) evidence.push(`${Math.round(capRate * 100)}% of mid-sentence line breaks start with a capital`);
    if (ch) evidence.push(`${ch} counting sequence(s) of margin numbers`);
    if (endPunctRate < 0.35) evidence.push(`only ${Math.round(endPunctRate * 100)}% of lines end in punctuation — looks like list entries`);
    if (recordRate >= 0.2) evidence.push(`${Math.round(recordRate * 100)}% of lines carry years/ISBN-like numbers — looks like records`);
    return { start, end, lines: end - start + 1, turnovers, capRate, capSample: ct, recordRate, endPunctRate, chains: ch, consistency: { pairs, ok }, evidence };
  }

  return { verse, regions, chains, margin };
}
