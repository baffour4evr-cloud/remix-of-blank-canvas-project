/**
 * Last-resort extraction for spans the file supplies no Unicode mapping for.
 *
 * Some embedded fonts (display faces, small-caps title faces, badly subsetted
 * fonts) carry no /ToUnicode table and no usable encoding, so the engine
 * honestly reports "no character here". The characters are nonetheless *visible*
 * on the page, so the only sound evidence left is the rendered glyphs
 * themselves: the span's own region is rasterized and read by OCR.
 *
 * This is an alternative extraction source, not a repair heuristic: nothing is
 * inferred from other fonts, other spans, document statistics or code offsets,
 * and every recovered span keeps its original evidence plus a confidence.
 */

import type { OcrAssets } from "../ingest/tesseract";
import { renderPage } from "./pdfium";
import { UNUSABLE, mappingGroups } from "./reconstruct";
import type { SourceDoc } from "./types";
/** Rendering scale for the glyph crop. Small text needs the resolution. */
const SCALE = 4;
/** Padding around the span box, as a fraction of its height: OCR needs margin. */
const PAD_RATIO = 0.5;
const MIN_PAD = 8;
/** Below this the recovery is discarded and the span stays unresolved. */
const MIN_CONFIDENCE = 0.6;

export interface RecoveredSpan {
  page: number;
  /** extraction order of the span's first character: the span's identity */
  order: number;
  text: string;
  confidence: number;
}

function crop(
  raster: { data: Uint8Array; width: number; height: number },
  x: number,
  y: number,
  w: number,
  h: number,
): { data: Uint8Array; width: number; height: number } | null {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(raster.width, Math.ceil(x + w));
  const y1 = Math.min(raster.height, Math.ceil(y + h));
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw < 4 || ch < 4) return null;
  const data = new Uint8Array(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const src = ((y0 + row) * raster.width + x0) * 4;
    data.set(raster.data.subarray(src, src + cw * 4), row * cw * 4);
  }
  return { data, width: cw, height: ch };
}

/**
 * Read the rendered glyphs of every unmapped span in the document.
 * Pages are rendered at most once, and only pages that need it.
 */
export async function recoverUnmappedSpans(
  source: SourceDoc,
  bytes: Uint8Array,
  wasmBinary: Uint8Array,
  assets: OcrAssets,
  opts: { maxPages?: number } = {},
): Promise<RecoveredSpan[]> {
  const out: RecoveredSpan[] = [];
  const pages = source.pages.filter((p) => p.runs.some((r) => r.chars.some((c) => UNUSABLE.test(c.ch))));
  if (!pages.length) return out;
  const { getEngine } = await import("../ingest/tesseract");
  const engine = await getEngine(assets);
  for (const page of pages.slice(0, opts.maxPages ?? pages.length)) {
    let raster: Awaited<ReturnType<typeof renderPage>>;
    try {
      raster = await renderPage(bytes, wasmBinary, page.page, SCALE);
    } catch {
      continue;
    }
    for (const run of page.runs) {
      for (const group of mappingGroups(run.chars)) {
        // Only spans the file gave no characters for are read off the page.
        if (!group.some((c) => UNUSABLE.test(c.ch))) continue;
        const boxes = group.map((c) => c.bbox).filter((b): b is NonNullable<typeof b> => !!b);
        if (!boxes.length) continue;
        const left = Math.min(...boxes.map((b) => b.x));
        const right = Math.max(...boxes.map((b) => b.x + b.w));
        const bottom = Math.min(...boxes.map((b) => b.y));
        const top = Math.max(...boxes.map((b) => b.y + b.h));
        // Vertical margin helps the recognizer; horizontal margin is kept tight
        // so neighbouring characters the file *did* decode stay out of the crop.
        const padY = Math.max(MIN_PAD, (top - bottom) * SCALE * PAD_RATIO);
        const padX = 2;
        const region = crop(
          raster,
          left * SCALE - padX,
          (page.height - top) * SCALE - padY,
          (right - left) * SCALE + padX * 2,
          (top - bottom) * SCALE + padY * 2,
        );
        if (!region) continue;
        try {
          engine.loadImage(region);
          const words = engine.getTextBoxes("word");
          engine.clearImage();
          const kept = words.filter((w) => w.text.trim());
          if (!kept.length) continue;
          const text = kept
            .sort((a, b) => a.rect.left - b.rect.left)
            .map((w) => w.text.trim())
            .join(" ");
          const confidence =
            Math.round((kept.reduce((s, w) => s + w.confidence, 0) / kept.length) * 1000) / 1000;
          if (confidence < MIN_CONFIDENCE) continue;
          out.push({ page: page.page, order: group[0]!.i, text, confidence });
        } catch {
          /* a span that cannot be read stays unresolved */
        }
      }
    }
  }
  return out;
}
