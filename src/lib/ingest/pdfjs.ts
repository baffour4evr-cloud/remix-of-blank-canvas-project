// Direct pdf.js access for the OCR path.
//
// The text extractor uses unpdf, whose bundled pdf.js cannot decode some image
// codecs (JBIG2 in particular). The OCR path therefore opens the file with
// pdfjs-dist directly and pulls the *raw decoded image data* out of the page's
// object store — no canvas, no DOM, no page rendering.

import type { ExtractionMethod, PageClass, PageKind, ScanReport } from "../ocr/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const PAINT_IMAGE_XOBJECT = 85;
const PAINT_INLINE_IMAGE = 86;
const PAINT_IMAGE_MASK_XOBJECT = 83;

/**
 * pdf.js runs in-process here: this module is only ever loaded inside the
 * browser ingest worker (src/lib/ingest/ingest.worker.ts), which is already a
 * background thread, so pdf.js must not try to spawn a nested worker of its own.
 * Registering `globalThis.pdfjsWorker.WorkerMessageHandler` makes pdf.js run
 * its worker code in the same thread with no runtime path lookup at all.
 * Never import this module from server code (enforced by server-engines.test.ts).
 */
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const g = globalThis as any;
if (!g.pdfjsWorker?.WorkerMessageHandler) g.pdfjsWorker = { WorkerMessageHandler };
// Never leave a relative specifier that the fake-worker loader could reach for.
(pdfjs as any).GlobalWorkerOptions.workerSrc = "";

export async function openPdf(bytes: Uint8Array): Promise<any> {
  if (!g.pdfjsWorker?.WorkerMessageHandler) {
    throw new Error("pdf.js worker handler was not registered");
  }
  return await (pdfjs as any).getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    // In a browser pdf.js defaults both of these to true, which can hand decoded
    // images back as ImageBitmap objects with no pixel buffer. The OCR path reads
    // raw pixel buffers (what it received under Node, where both default to
    // false), so both are switched off explicitly.
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  }).promise;
}

/**
 * Score how *usable* a page's text layer is, independent of how much of it
 * there is. A PDF can carry a technically valid text layer that decodes to
 * nothing readable — broken CID maps, symbolic fonts with no ToUnicode, or a
 * layer of replacement characters over a scan. Those pages must go to OCR too.
 *
 * Everything here is generic evidence about the characters themselves: no
 * filenames, titles, page ranges or document identities are consulted.
 */
export function textQuality(text: string): { quality: number; why: string } {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s) return { quality: 0, why: "empty text layer" };
  let letters = 0;
  let bad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (/\p{L}/u.test(ch)) letters++;
    // replacement / undecodable glyphs, private-use area, control characters
    if (ch === "\uFFFD" || (c >= 0xe000 && c <= 0xf8ff) || (c < 0x20 && ch !== "\n" && ch !== "\t")) bad++;
  }
  const alpha = letters / s.length;
  const badRatio = bad / s.length;

  // Word shape: real prose is mostly short-to-medium tokens that contain a
  // vowel-like letter. Mojibake collapses into long vowel-less runs.
  const words = s.split(" ").filter((w) => /\p{L}/u.test(w));
  const sane = words.filter((w) => {
    const core = w.replace(/[^\p{L}]/gu, "");
    return core.length > 0 && core.length <= 24 && /[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüαεηιουωаеиоуыэюя]/i.test(core);
  }).length;
  const saneRatio = words.length ? sane / words.length : 0;

  const quality = Math.max(0, Math.min(1, alpha * 0.4 + (1 - badRatio) * 0.2 + saneRatio * 0.4));
  const why =
    badRatio > 0.1
      ? `${Math.round(badRatio * 100)}% undecodable glyphs in the text layer`
      : saneRatio < 0.5
        ? `only ${Math.round(saneRatio * 100)}% of tokens look like words`
        : `text layer scores ${quality.toFixed(2)}`;
  return { quality: Math.round(quality * 100) / 100, why };
}

/** Below this the text layer counts as unusable and the page is OCR'd. */
const MIN_QUALITY = 0.55;
/** Below this there is too little text to call the page native at all. */
const MIN_CHARS = 60;

/**
 * Classify every page as native-text or scan-candidate from the cheapest
 * reliable evidence: how much text the page's own text layer yields, and how
 * readable that text is. Image evidence is expensive to gather (it decodes
 * every raster), so it is recorded later, when the OCR pass opens the page.
 */
export async function classifyDocument(
  pdf: any,
  onProgress?: (page: number, total: number) => void,
): Promise<ScanReport> {
  const total = pdf.numPages;
  const pages: PageClass[] = [];
  for (let n = 1; n <= total; n++) {
    const page = await pdf.getPage(n);
    let chars = 0;
    let text = "";
    try {
      const content = await page.getTextContent();
      for (const it of content.items as { str?: string }[]) {
        const s = it.str ?? "";
        chars += s.trim().length;
        text += s + " ";
      }
    } catch {
      chars = 0;
    }
    const { quality, why } = textQuality(text);
    const thin = chars < MIN_CHARS;
    const unusable = !thin && quality < MIN_QUALITY;
    const method: ExtractionMethod = thin || unusable ? "ocr" : "native";
    // A thin page is a scan candidate until the OCR pass reports whether it
    // actually carries an image; a blank page is reclassified `empty` then.
    const kind: PageKind = thin ? "scanned" : unusable ? "poor_native" : "native";
    pages.push({
      page: n,
      kind,
      method,
      chars,
      quality,
      recovered: unusable,
      images: 0,
      imageCoverage: 0,
      reason: thin
        ? `${chars} characters in the text layer — page sent to OCR`
        : unusable
          ? `text layer present but unusable (${why}) — page sent to OCR`
          : `${chars} characters in the text layer, ${why}`,
    });
    page.cleanup();
    onProgress?.(n, total);
  }

  const ocrPages = pages.filter((p) => p.method === "ocr").map((p) => p.page);
  const native = pages.filter((p) => p.method === "native").length;
  const kind =
    ocrPages.length === 0 && native === 0
      ? "empty"
      : ocrPages.length === 0
        ? "native-text"
        : native === 0
          ? "scanned"
          : "mixed";
  return { kind, pageCount: total, pages, ocrPages };
}

export interface PageRaster {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel */
  data: Uint8Array;
  pdfWidth: number;
  pdfHeight: number;
}

/** Longest edge an OCR raster is allowed to have (keeps worker memory bounded). */
const MAX_EDGE = 3000;

/** How long to wait for an image object the page is still decoding. */
const OBJECT_TIMEOUT_MS = 30_000;

/**
 * Fetch a page-level object (an image XObject) by name.
 *
 * pdf.js only hands small images back inside the operator list; anything
 * larger — i.e. every scanned page — is decoded asynchronously and published
 * to the page's object store afterwards. Reading it synchronously throws
 * ("Requesting object that isn't resolved yet"), which would make a perfectly
 * good scan look like a blank page, so the object is awaited instead.
 */
async function pageObject(page: any, name: string): Promise<any> {
  // An image used on more than one page is published once, to the document-wide
  // store, so both stores have to be consulted.
  for (const store of [page.objs, page.commonObjs]) {
    if (!store) continue;
    try {
      if (store.has?.(name)) {
        const obj = store.get(name);
        if (obj) return obj;
      }
    } catch {
      /* not resolved yet */
    }
  }
  return await new Promise<any>((resolve) => {
    let settled = false;
    const done = (obj: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(obj ?? null);
    };
    const timer = setTimeout(() => done(null), OBJECT_TIMEOUT_MS);
    for (const store of [page.objs, page.commonObjs]) {
      if (!store) continue;
      try {
        store.get(name, done);
      } catch {
        /* the other store may still deliver it */
      }
    }
  });
}

export interface PageRasterReport {
  raster: PageRaster | null;
  /** image-paint operations found on the page */
  imageOps: number;
  /** images that were found but could not be turned into pixels, and why */
  undecodable: string[];
}

/** Read an ImageBitmap's pixels (pdf.js hands images back this way in some browser configurations). */
async function bitmapPixels(bitmap: ImageBitmap): Promise<{ width: number; height: number; data: Uint8Array }> {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("an image arrived as a bitmap but OffscreenCanvas is unavailable");
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("could not create a 2d context to read an image bitmap");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { width: px.width, height: px.height, data: new Uint8Array(px.data.buffer, px.data.byteOffset, px.data.byteLength) };
}

/**
 * Decode the largest raster image on a page into RGBA, without rendering, and
 * report what was found. A page that has image operations but yields no pixels
 * is NOT blank: the report says so, so the caller can fail loudly.
 */
export async function pageRasterReport(page: any): Promise<PageRasterReport> {
  const view = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  let best: any = null;
  let imageOps = 0;
  const undecodable: string[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn !== PAINT_IMAGE_XOBJECT && fn !== PAINT_INLINE_IMAGE && fn !== PAINT_IMAGE_MASK_XOBJECT) continue;
    imageOps++;
    const arg = (ops.argsArray[i] as any[])[0];
    const label = typeof arg === "string" ? arg : "inline image";
    const obj = typeof arg === "string" ? await pageObject(page, arg) : arg;
    if (!obj?.width) {
      undecodable.push(`${label}: the image object never resolved`);
      continue;
    }
    if (!obj.data && !obj.bitmap) {
      undecodable.push(`${label}: the image has neither a pixel buffer nor a bitmap`);
      continue;
    }
    if (!best || obj.width * obj.height > best.width * best.height) best = obj;
  }
  if (!best) return { raster: null, imageOps, undecodable };

  let w: number = best.width;
  let h: number = best.height;
  let rgba: Uint8Array;

  if (!best.data) {
    const px = await bitmapPixels(best.bitmap as ImageBitmap);
    w = px.width;
    h = px.height;
    rgba = px.data;
    (best.bitmap as ImageBitmap).close?.();
  } else {
    const src: Uint8Array | Uint8ClampedArray = best.data;
    const kind: number = best.kind ?? 0;
    rgba = new Uint8Array(w * h * 4);
    if (kind === 3 || (kind === 0 && src.length >= w * h * 4)) {
      rgba.set(src.subarray(0, w * h * 4));
    } else if (kind === 2 || src.length >= w * h * 3) {
      for (let p = 0, s = 0, o = 0; p < w * h; p++, s += 3, o += 4) {
        rgba[o] = src[s]!;
        rgba[o + 1] = src[s + 1]!;
        rgba[o + 2] = src[s + 2]!;
        rgba[o + 3] = 255;
      }
    } else if (src.length >= w * h) {
      // 8-bit grayscale
      for (let p = 0, o = 0; p < w * h; p++, o += 4) {
        const v = src[p]!;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        rgba[o + 3] = 255;
      }
    } else {
      // 1 bit per pixel, packed rows
      const rowBytes = Math.ceil(w / 8);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const bit = (src[y * rowBytes + (x >> 3)]! >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0;
          const o = (y * w + x) * 4;
          rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
          rgba[o + 3] = 255;
        }
      }
    }
  }

  const raster: PageRaster = { width: w, height: h, data: rgba, pdfWidth: view.width, pdfHeight: view.height };
  return {
    raster: Math.max(w, h) > MAX_EDGE ? downscale(raster, MAX_EDGE / Math.max(w, h)) : raster,
    imageOps,
    undecodable,
  };
}

export async function pageRaster(page: any): Promise<PageRaster | null> {
  return (await pageRasterReport(page)).raster;
}

/** Box-filter downscale; OCR only ever needs ~300dpi. */
function downscale(img: PageRaster, factor: number): PageRaster {
  const w = Math.max(1, Math.round(img.width * factor));
  const h = Math.max(1, Math.round(img.height * factor));
  const out = new Uint8Array(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          sum += img.data[(yy * img.width + xx) * 4]!;
          n++;
        }
      const v = n ? Math.round(sum / n) : 255;
      const o = (y * w + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out, pdfWidth: img.pdfWidth, pdfHeight: img.pdfHeight };
}
