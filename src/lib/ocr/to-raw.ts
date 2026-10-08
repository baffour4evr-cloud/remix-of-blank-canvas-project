// OCR words -> the same positioned-span model a PDF text layer produces.
//
// This is the join point of the two ingestion paths: after this function the
// rest of the pipeline (geometry, reading order, structure, normalization,
// references) cannot tell the difference.

import type { RawItem, RawPage } from "../reader/types";
import type { OcrPageArtifact } from "./types";

export function ocrPageToRaw(a: OcrPageArtifact): RawPage {
  const sx = a.imgWidth > 0 ? a.pdfWidth / a.imgWidth : 1;
  const sy = a.imgHeight > 0 ? a.pdfHeight / a.imgHeight : 1;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  // An OCR line's pixel height depends on which ascenders and descenders it
  // happens to contain, so raw heights would look like a dozen different font
  // sizes. Snap everything near the page's dominant line height to that value;
  // genuinely larger lines (headings) keep their measured size.
  const heights = a.words.map((w) => Math.round((w.lh || w.h) * sy));
  const freq = new Map<number, number>();
  for (const h of heights) freq.set(h, (freq.get(h) ?? 0) + 1);
  let mode = 0;
  let modeN = 0;
  for (const [h, n] of freq) if (n > modeN || (n === modeN && h > mode)) ((mode = h), (modeN = n));
  const snap = (h: number) => (mode > 0 && Math.abs(h - mode) <= mode * 0.3 ? mode : h);

  const items: RawItem[] = a.words.map((w) => ({
    // PDF user space has its origin bottom-left; OCR boxes are top-left.
    x: r2(w.x * sx),
    // baseline of the printed line, so line clustering sees one line per line
    y: r2(a.pdfHeight - (w.ly || w.y + w.h) * sy),
    w: r2(w.w * sx),
    s: snap(Math.round((w.lh || w.h) * sy)),
    f: "ocr",
    // OCR already knows where the word boundaries are; carrying them as explicit
    // whitespace keeps the downstream gap heuristics (tuned for PDF glyph runs)
    // from ever gluing two scanned words together.
    t: `${w.t} `,
    conf: w.c,
  }));

  return {
    page: a.page,
    width: a.pdfWidth,
    height: a.pdfHeight,
    items,
    links: [],
    method: "ocr",
    ocr: {
      meanConfidence: a.meanConfidence,
      words: a.words.length,
      lowConfidenceWords: a.lowConfidenceWords,
      ...(a.error ? { error: a.error } : {}),
    },
  };
}
