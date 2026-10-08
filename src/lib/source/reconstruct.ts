/**
 * Document reconstruction: source evidence -> positioned text spans.
 *
 * This is the only place where evidence becomes a reading representation, and
 * it is deliberately narrow:
 *
 *  - words and spaces are the engine's own segmentation. No gap heuristic
 *    invents or removes a space.
 *  - lines are the engine's own line delimiters.
 *  - typography (italic, bold, small caps, monospace) is read from the font's
 *    identity and descriptor flags. It never changes a character.
 *  - a character the file supplies no mapping for is kept as the replacement
 *    character and its span is marked uncertain. Nothing is guessed from
 *    statistics, offsets or neighbouring fonts.
 *  - spans are split where mapping availability changes, so a later recovery of
 *    undecodable glyphs can never overwrite a character the file decoded.
 */

import type { RawDoc, RawItem, RawLink, RawPage } from "../reader/types";
import { normalizeText } from "../reader/unicode";
import type { PdfiumFont } from "./pdfium";
import type { SourceChar, SourceDoc, SourceRun } from "./types";

/** Codepoints that mean "the file gave us no usable character here". */
export const UNUSABLE = /[\u0000\uFFFD]/;

/** Small capitals are a property of the *font*, never of the letters. */
const SMALL_CAPS_NAME = /(small[\s_-]?caps?|smcp|[-_](sc|scaps)\b)/i;

export function isSmallCapsFont(font: { psName: string; smallCapFlag?: boolean }): boolean {
  return !!font.smallCapFlag || SMALL_CAPS_NAME.test(font.psName);
}

function round(v: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/**
 * Split a run's characters into maximal groups that are either all decodable or
 * all undecodable. Whitespace joins whichever group it borders so a heading does
 * not fragment on its own spaces.
 */
export function mappingGroups(chars: SourceChar[]): SourceChar[][] {
  const groups: SourceChar[][] = [];
  let current: SourceChar[] = [];
  let currentBad: boolean | null = null;
  for (const c of chars) {
    if (/^\s*$/.test(c.ch)) {
      current.push(c);
      continue;
    }
    const bad = UNUSABLE.test(c.ch);
    if (currentBad !== null && bad !== currentBad) {
      // hand trailing whitespace to the new group
      const tail: SourceChar[] = [];
      while (current.length && /^\s*$/.test(current[current.length - 1]!.ch)) tail.unshift(current.pop()!);
      if (current.length) groups.push(current);
      current = tail;
    }
    currentBad = bad;
    current.push(c);
  }
  if (current.length) groups.push(current);
  return groups;
}

function itemOf(run: SourceRun, chars: SourceChar[], font: PdfiumFont | undefined): RawItem | null {
  const raw = chars.map((c) => c.ch).join("");
  if (raw === "") return null;
  const unusable = chars.filter((c) => UNUSABLE.test(c.ch)).length;
  const text = normalizeText(raw);
  if (text.trim() === "" && unusable === 0) return null;
  const boxes = chars.map((c) => c.bbox).filter((b): b is NonNullable<typeof b> => !!b);
  const x = boxes.length ? Math.min(...boxes.map((b) => b.x)) : run.bbox.x;
  const right = boxes.length ? Math.max(...boxes.map((b) => b.x + b.w)) : run.bbox.x + run.bbox.w;
  const item: RawItem = {
    x: round(x),
    y: round(chars[0]!.origin?.y ?? run.origin.y),
    w: round(right - x),
    s: round(run.size, 1),
    f: run.fontId,
    t: text,
    t0: raw,
    o: chars[0]!.i,
    h: round(run.bbox.h),
  };
  if (font) {
    if (font.family) item.fam = font.family;
    if (font.flags.italic) item.em = true;
    if (font.flags.bold) item.strong = true;
    if (isSmallCapsFont(font)) item.sc = true;
    if (font.fixedPitch) item.mono = true;
  }
  if (unusable > 0) {
    item.uncertain = true;
    item.unmapped = unusable;
  }
  return item;
}

export interface ReconstructOptions {
  /** used when the file carries no embedded title */
  title?: string;
}

/** Turn observed source evidence into the shared positioned-span model. */
export function reconstruct(source: SourceDoc, opts: ReconstructOptions = {}): RawDoc {
  const fonts = source.fonts as unknown as Record<string, PdfiumFont>;
  const pages: RawPage[] = source.pages.map((p) => {
    const items: RawItem[] = [];
    for (const run of p.runs) {
      for (const group of mappingGroups(run.chars)) {
        const item = itemOf(run, group, fonts[run.fontId]);
        if (item) items.push(item);
      }
    }
    const chars = p.runs.flatMap((r) => r.chars);
    const links: RawLink[] = p.links.map((l) => {
      const link: RawLink = {
        x: round(l.rect.x),
        y: round(l.rect.y),
        w: round(l.rect.w),
        h: round(l.rect.h),
        destPage: l.destPage,
        destY: l.destY,
        url: l.url,
        id: l.id,
        charRange: l.charRange,
      };
      if (l.charRange) {
        const text = chars
          .filter((c) => c.i >= l.charRange!.start && c.i < l.charRange!.end)
          .map((c) => c.ch)
          .join("")
          .trim();
        if (text) link.text = text;
      }
      return link;
    });
    return {
      page: p.page,
      width: round(p.width),
      height: round(p.height),
      items,
      links,
      method: items.length ? ("native" as const) : ("empty" as const),
    };
  });

  const title = source.meta.title ?? opts.title;
  return {
    pageCount: source.pageCount,
    meta: {
      ...(title ? { title } : {}),
      ...(source.meta.author ? { author: source.meta.author } : {}),
    },
    outline: source.outline.map((o) => ({ title: o.title, page: o.page, depth: o.depth })),
    pages,
  };
}

/** Spans whose font supplied no usable Unicode mapping, per page. */
export function unmappedSpans(raw: RawDoc): Map<number, RawItem[]> {
  const out = new Map<number, RawItem[]>();
  for (const p of raw.pages) {
    const bad = p.items.filter((i) => i.unmapped);
    if (bad.length) out.set(p.page, bad);
  }
  return out;
}
