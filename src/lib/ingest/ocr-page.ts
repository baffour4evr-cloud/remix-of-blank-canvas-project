// OCR one page image into word boxes. Produces exactly the same kind of
// evidence a native text layer gives: positioned words with sizes.

import { getEngine, type OcrAssets } from "./tesseract";
import { pageRasterReport } from "./pdfjs";
import type { OcrPageArtifact, OcrWord } from "../ocr/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Otsu binarization — helps Tesseract on soft greyscale scans. */
function binarize(data: Uint8Array) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) hist[data[i]! as number] = (hist[data[i]!] ?? 0) + 1;
  const total = data.length / 4;
  let mid = 0;
  for (let v = 40; v < 216; v++) mid += hist[v]!;
  if (mid / total < 0.04) return; // already essentially bilevel

  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]!;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += v * hist[v]!;
    const between = wB * wF * Math.pow(sumB / wB - (sum - sumB) / wF, 2);
    if (between > best) {
      best = between;
      threshold = v;
    }
  }
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i]! > threshold ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = v;
  }
}

const LOW_CONFIDENCE = 0.6;

export async function ocrPdfPage(pdf: any, pageNo: number, assets: OcrAssets): Promise<OcrPageArtifact> {
  const started = Date.now();
  const page = await pdf.getPage(pageNo);
  const view = page.getViewport({ scale: 1 });
  const base: OcrPageArtifact = {
    page: pageNo,
    imgWidth: 0,
    imgHeight: 0,
    pdfWidth: view.width,
    pdfHeight: view.height,
    words: [],
    meanConfidence: 0,
    lowConfidenceWords: 0,
    ms: 0,
  };
  try {
    const { raster, imageOps, undecodable } = await pageRasterReport(page);
    if (!raster) {
      // Image operations that yield no pixels are a FAILURE, never a blank page.
      if (imageOps > 0) {
        return {
          ...base,
          hasImage: true,
          error: `page has ${imageOps} image(s) but none could be decoded: ${undecodable.join("; ") || "unknown reason"}`,
          ms: Date.now() - started,
        };
      }
      // No text and no image operations: the page is genuinely blank.
      return { ...base, hasImage: false, ms: Date.now() - started };
    }
    binarize(raster.data);

    const engine = await getEngine(assets);
    let lineBoxes: ReturnType<typeof engine.getTextBoxes>;
    let boxes: ReturnType<typeof engine.getTextBoxes>;
    try {
      engine.loadImage({ data: raster.data, width: raster.width, height: raster.height });
      lineBoxes = engine.getTextBoxes("line");
      boxes = engine.getTextBoxes("word");
    } finally {
      engine.clearImage();
    }

    const words: OcrWord[] = [];
    let confSum = 0;
    let low = 0;
    // Words are placed on their *line's* baseline, not their own box: a word
    // with a descender sits lower than its neighbours, and per-word geometry
    // would split one printed line into several.
    const lineOf = (b: { rect: { left: number; top: number; right: number; bottom: number } }) => {
      const cx = (b.rect.left + b.rect.right) / 2;
      const cy = (b.rect.top + b.rect.bottom) / 2;
      let best = -1;
      let bestDy = Infinity;
      for (let i = 0; i < lineBoxes.length; i++) {
        const r = lineBoxes[i]!.rect;
        if (cx < r.left - 4 || cx > r.right + 4) continue;
        const dy = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
        if (dy < bestDy) {
          bestDy = dy;
          best = i;
        }
      }
      return best;
    };

    for (const b of boxes) {
      const t = b.text.trim();
      if (!t) continue;
      const li = lineOf(b);
      const lr = li >= 0 ? lineBoxes[li]!.rect : b.rect;
      const w: OcrWord = {
        t,
        x: b.rect.left,
        y: b.rect.top,
        w: b.rect.right - b.rect.left,
        h: b.rect.bottom - b.rect.top,
        c: Math.round(b.confidence * 1000) / 1000,
        l: li,
        ly: lr.bottom,
        lh: lr.bottom - lr.top,
      };
      if (b.flags & 1) w.sol = true;
      words.push(w);
      confSum += b.confidence;
      if (b.confidence < LOW_CONFIDENCE) low++;
    }
    return {
      ...base,
      imgWidth: raster.width,
      imgHeight: raster.height,
      hasImage: true,
      words,
      meanConfidence: words.length ? Math.round((confSum / words.length) * 1000) / 1000 : 0,
      lowConfidenceWords: low,
      ms: Date.now() - started,
    };
  } catch (e) {
    return { ...base, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  } finally {
    page.cleanup();
  }
}
