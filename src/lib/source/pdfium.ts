/**
 * PDFium producer for the source-evidence contract.
 *
 * PDFium (Chromium's PDF engine, BSD/Apache licensed, compiled to WASM) is the
 * extraction engine of record. It is used here for one reason: it reports
 * *per character* — the Unicode value it resolved, the character's box, its
 * baseline origin, its font and its size — and it reports honestly, emitting
 * U+0000 for a glyph whose font supplies no usable mapping instead of inventing
 * a plausible-looking character.
 *
 * This module observes. It performs no character correction, no font guessing,
 * no Unicode substitution, no small-caps conversion, no word/paragraph
 * reconstruction and no semantic interpretation. Interpretation happens in
 * `reconstruct.ts` and downstream.
 */

import { init } from "./vendor/pdfium-web.js";
import type {
  Box,
  FontRef,
  SourceChar,
  SourceDoc,
  SourceLink,
  SourceOutlineEntry,
  SourcePage,
  SourceRun,
} from "./types";

export const PRODUCER = "pdfium";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Pdfium = any;

let modulePromise: Promise<Pdfium> | null = null;

/** One PDFium instance per browser ingest worker. Never runs on the server. */
export async function pdfiumModule(wasmBinary: Uint8Array): Promise<Pdfium> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const m: Pdfium = await init({ wasmBinary: wasmBinary as unknown as ArrayBufferView });
      m.PDFiumExt_Init();
      return m;
    })();
  }
  return modulePromise;
}

class Scratch {
  private ptrs: number[] = [];
  constructor(private m: Pdfium) {}
  alloc(bytes: number): number {
    const p = this.m.pdfium.wasmExports.malloc(bytes);
    this.ptrs.push(p);
    return p;
  }
  free() {
    for (const p of this.ptrs) this.m.pdfium.wasmExports.free(p);
    this.ptrs = [];
  }
}

const dbl = (m: Pdfium, ptr: number, i = 0) => m.pdfium.getValue(ptr + i * 8, "double") as number;
const flt = (m: Pdfium, ptr: number, i = 0) => m.pdfium.getValue(ptr + i * 4, "float") as number;
const int = (m: Pdfium, ptr: number) => m.pdfium.getValue(ptr, "i32") as number;

/** Read a UTF-16LE string the engine wrote into WASM memory. */
function utf16(m: Pdfium, read: (ptr: number, len: number) => number): string {
  const len = read(0, 0);
  if (len <= 2) return "";
  const s = new Scratch(m);
  try {
    const p = s.alloc(len);
    read(p, len);
    return (m.pdfium.UTF16ToString(p) as string) ?? "";
  } finally {
    s.free();
  }
}

const SUBSET_TAG = /^([A-Z]{6})\+(.*)$/;

/** PDFium font descriptor flags (PDF spec, table 123). */
const FLAG_FIXED = 1 << 0;
const FLAG_SERIF = 1 << 1;
const FLAG_SYMBOLIC = 1 << 2;
const FLAG_ITALIC = 1 << 6;
const FLAG_SMALLCAP = 1 << 17;
const FLAG_FORCEBOLD = 1 << 18;

export interface PdfiumFont extends FontRef {
  /** descriptor flag word exactly as reported */
  descriptorFlags: number;
  /** weight exactly as reported (400 = regular, 700 = bold) */
  weight: number;
  /** the /Flags small-cap bit, as reported — evidence, never applied to text */
  smallCapFlag: boolean;
  fixedPitch: boolean;
  symbolic: boolean;
}

/** Weight names as stated by the font's own PostScript name. */
const BOLD_NAME = /(bold|black|heavy|semib|demib)/i;

function fontOf(name: string, flags: number, weight: number): PdfiumFont {
  const m = SUBSET_TAG.exec(name);
  return {
    id: `${name}|${flags}|${weight}`,
    handle: name,
    psName: name,
    family: m ? m[2]! : name,
    subset: m ? m[1]! : null,
    subtype: null,
    flags: {
      // The engine estimates a weight when the font program does not state one,
      // and those estimates run high (an italic text face can report 610), so
      // weight alone is not evidence of bold.
      bold: weight >= 700 || (flags & FLAG_FORCEBOLD) !== 0 || BOLD_NAME.test(name),
      italic: (flags & FLAG_ITALIC) !== 0,
      black: weight >= 800,
      vertical: null,
      type3: null,
      missingFile: null,
    },
    hasEmbeddedProgram: null,
    ascent: null,
    descent: null,
    bbox: null,
    descriptorFlags: flags,
    weight,
    smallCapFlag: (flags & FLAG_SMALLCAP) !== 0,
    fixedPitch: (flags & FLAG_FIXED) !== 0,
    symbolic: (flags & FLAG_SYMBOLIC) !== 0 && (flags & FLAG_SERIF) === 0,
  };
}

interface CharEvidence {
  ch: string;
  code: number;
  box: Box | null;
  origin: { x: number; y: number } | null;
  size: number;
  fontId: string;
}

function readChars(m: Pdfium, tp: number, count: number, fonts: Record<string, PdfiumFont>): CharEvidence[] {
  const s = new Scratch(m);
  const out: CharEvidence[] = [];
  try {
    const boxPtr = s.alloc(32);
    const originPtr = s.alloc(16);
    const flagsPtr = s.alloc(4);
    const namePtr = s.alloc(256);
    for (let i = 0; i < count; i++) {
      const code = m.FPDFText_GetUnicode(tp, i) as number;
      const size = m.FPDFText_GetFontSize(tp, i) as number;
      const n = m.FPDFText_GetFontInfo(tp, i, namePtr, 256, flagsPtr) as number;
      const name = n > 0 ? ((m.pdfium.UTF8ToString(namePtr) as string) ?? "") : "";
      const flags = int(m, flagsPtr);
      const weight = m.FPDFText_GetFontWeight(tp, i) as number;
      const font = fontOf(name || "unnamed", flags, weight);
      if (!fonts[font.id]) fonts[font.id] = font;

      let box: Box | null = null;
      if (m.FPDFText_GetCharBox(tp, i, boxPtr, boxPtr + 8, boxPtr + 16, boxPtr + 24)) {
        const left = dbl(m, boxPtr, 0);
        const right = dbl(m, boxPtr, 1);
        const bottom = dbl(m, boxPtr, 2);
        const top = dbl(m, boxPtr, 3);
        box = { x: left, y: bottom, w: right - left, h: top - bottom };
      }
      let origin: { x: number; y: number } | null = null;
      if (m.FPDFText_GetCharOrigin(tp, i, originPtr, originPtr + 8)) {
        origin = { x: dbl(m, originPtr, 0), y: dbl(m, originPtr, 1) };
      }
      out.push({
        ch: code > 0 ? String.fromCodePoint(code) : "\u0000",
        code,
        box,
        origin,
        size,
        fontId: font.id,
      });
    }
  } finally {
    s.free();
  }
  return out;
}

/** One engine-reported line, as PDFium delimits it with CR/LF characters. */
function segmentRuns(chars: CharEvidence[]): SourceRun[] {
  const runs: SourceRun[] = [];
  let order = 0;
  let current: SourceChar[] = [];
  let currentKey = "";

  const flush = () => {
    if (!current.length) {
      currentKey = "";
      return;
    }
    const boxes = current.map((c) => c.bbox).filter((b): b is Box => !!b);
    const x = boxes.length ? Math.min(...boxes.map((b) => b.x)) : 0;
    const y = boxes.length ? Math.min(...boxes.map((b) => b.y)) : 0;
    const right = boxes.length ? Math.max(...boxes.map((b) => b.x + b.w)) : 0;
    const top = boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) : 0;
    const first = current[0]!;
    runs.push({
      order: order++,
      fontId: first.fontId,
      size: first.size,
      text: current.map((c) => c.ch).join(""),
      chars: current,
      bbox: { x, y, w: right - x, h: top - y },
      origin: first.origin ?? { x, y },
      hasEOL: false,
      width: right - x,
    });
    current = [];
    currentKey = "";
  };

  let index = 0;
  for (const c of chars) {
    // CR/LF are the engine's own line delimiters, not page content.
    if (c.code === 13 || c.code === 10) {
      if (runs.length && current.length === 0) runs[runs.length - 1]!.hasEOL = true;
      flush();
      if (runs.length) runs[runs.length - 1]!.hasEOL = true;
      continue;
    }
    const key = `${c.fontId}|${Math.round(c.size * 10)}`;
    if (currentKey && key !== currentKey) flush();
    currentKey = key;
    current.push({
      i: index++,
      ch: c.ch,
      code: c.code > 0 ? c.code : null,
      gid: null,
      fontChar: null,
      accent: null,
      isSpaceGlyph: c.code === 32 ? true : null,
      inFont: null,
      advance: null,
      origin: c.origin,
      bbox: c.box,
      geometry: c.box ? "glyph-advance" : "none",
      unicodeSource: "engine-mapped",
      fontId: c.fontId,
      size: c.size,
      run: runs.length,
      link: null,
    });
  }
  flush();
  return runs;
}

function readLinks(
  m: Pdfium,
  doc: number,
  page: number,
  pageNo: number,
  runs: SourceRun[],
): SourceLink[] {
  const s = new Scratch(m);
  const links: SourceLink[] = [];
  try {
    const posPtr = s.alloc(4);
    const linkPtr = s.alloc(4);
    const rectPtr = s.alloc(16);
    const destPtr = s.alloc(32);
    m.pdfium.setValue(posPtr, 0, "i32");
    let guard = 0;
    while (m.FPDFLink_Enumerate(page, posPtr, linkPtr) && guard++ < 2000) {
      const link = int(m, linkPtr);
      if (!link) continue;
      let rect: Box = { x: 0, y: 0, w: 0, h: 0 };
      if (m.FPDFLink_GetAnnotRect(link, rectPtr)) {
        const left = flt(m, rectPtr, 0);
        const top = flt(m, rectPtr, 1);
        const right = flt(m, rectPtr, 2);
        const bottom = flt(m, rectPtr, 3);
        rect = { x: Math.min(left, right), y: Math.min(top, bottom), w: Math.abs(right - left), h: Math.abs(top - bottom) };
      }
      let url: string | null = null;
      const action = m.FPDFLink_GetAction(link) as number;
      if (action) {
        const text = utf16(m, (p, len) => m.FPDFAction_GetURIPath(0, action, p, len) as number);
        if (text) url = text;
      }
      let destPage: number | null = null;
      let destY: number | null = null;
      // Destination lookups need the document handle: PDF destinations are
      // document-level objects, and a null handle silently resolves to nothing.
      const dest =
        (m.FPDFLink_GetDest(doc, link) as number) ||
        (action ? (m.FPDFAction_GetDest(doc, action) as number) : 0);
      if (dest) {
        const idx = m.FPDFDest_GetDestPageIndex(doc, dest) as number;
        if (idx >= 0) destPage = idx + 1;
        if (m.FPDFDest_GetLocationInPage(dest, destPtr, destPtr + 4, destPtr + 8, destPtr + 12, destPtr + 16, destPtr + 20)) {
          // out params: hasX, hasY, hasZoom (4 bytes each), then x, y, zoom
          const hasY = int(m, destPtr + 4);
          if (hasY) destY = flt(m, destPtr + 16);
        }
      }
      // Characters the rectangle covers, computed from reported geometry only.
      const covered: number[] = [];
      for (const run of runs) {
        for (const c of run.chars) {
          const b = c.bbox;
          if (!b) continue;
          const cx = b.x + b.w / 2;
          const cy = b.y + b.h / 2;
          if (cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h) covered.push(c.i);
        }
      }
      const id = `p${pageNo}l${links.length}`;
      links.push({
        id,
        rect,
        url,
        destPage,
        destY,
        charRange: covered.length ? { start: Math.min(...covered), end: Math.max(...covered) + 1 } : null,
        overlaidText: null,
      });
      if (covered.length) {
        const set = new Set(covered);
        for (const run of runs) for (const c of run.chars) if (set.has(c.i)) c.link = id;
      }
    }
  } finally {
    s.free();
  }
  return links;
}

function readOutline(m: Pdfium, doc: number): SourceOutlineEntry[] {
  const out: SourceOutlineEntry[] = [];
  const walk = (bookmark: number, depth: number) => {
    let node = bookmark;
    let guard = 0;
    while (node && guard++ < 5000) {
      const title = utf16(m, (p, len) => m.FPDFBookmark_GetTitle(node, p, len) as number);
      let page: number | null = null;
      const dest = m.FPDFBookmark_GetDest(doc, node) as number;
      if (dest) {
        const idx = m.FPDFDest_GetDestPageIndex(doc, dest) as number;
        if (idx >= 0) page = idx + 1;
      }
      if (title) out.push({ title, page, depth });
      const child = m.FPDFBookmark_GetFirstChild(doc, node) as number;
      if (child && depth < 6) walk(child, depth + 1);
      node = m.FPDFBookmark_GetNextSibling(doc, node) as number;
    }
  };
  walk(m.FPDFBookmark_GetFirstChild(doc, 0) as number, 0);
  return out;
}

export interface PdfiumDoc {
  doc: SourceDoc;
  fonts: Record<string, PdfiumFont>;
}

export interface ExtractOptions {
  onProgress?: (page: number, total: number) => void;
}

/** Open a PDF and report what it contains, character by character. */
export async function extractSourceDoc(
  bytes: Uint8Array,
  wasmBinary: Uint8Array,
  opts: ExtractOptions = {},
): Promise<PdfiumDoc> {
  const m = await pdfiumModule(wasmBinary);
  const filePtr = m.pdfium.wasmExports.malloc(bytes.length);
  m.pdfium.HEAPU8.set(bytes, filePtr);
  const doc = m.FPDF_LoadMemDocument(filePtr, bytes.length, "") as number;
  if (!doc) {
    m.pdfium.wasmExports.free(filePtr);
    throw new Error("the PDF could not be opened");
  }
  const fonts: Record<string, PdfiumFont> = {};
  try {
    const pageCount = m.FPDF_GetPageCount(doc) as number;
    const meta = (key: string) => utf16(m, (p, len) => m.FPDF_GetMetaText(doc, key, p, len) as number);
    const info: Record<string, string> = {};
    for (const key of ["Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) {
      const v = meta(key);
      if (v) info[key] = v;
    }
    const pages: SourcePage[] = [];
    for (let i = 0; i < pageCount; i++) {
      const page = m.FPDF_LoadPage(doc, i) as number;
      const width = m.FPDF_GetPageWidthF(page) as number;
      const height = m.FPDF_GetPageHeightF(page) as number;
      const rotation = ((m.FPDFPage_GetRotation(page) as number) || 0) * 90;
      const tp = m.FPDFText_LoadPage(page) as number;
      const count = Math.max(0, m.FPDFText_CountChars(tp) as number);
      const runs = segmentRuns(readChars(m, tp, count, fonts));
      const links = readLinks(m, doc, page, i + 1, runs);
      m.FPDFText_ClosePage(tp);
      m.FPDF_ClosePage(page);
      pages.push({
        page: i + 1,
        width,
        height,
        rotation,
        runs,
        links,
        images: [],
        method: runs.length ? "native" : "empty",
      });
      opts.onProgress?.(i + 1, pageCount);
    }
    return {
      fonts,
      doc: {
        version: 1,
        producer: PRODUCER,
        pageCount,
        meta: { title: meta("Title") || null, author: meta("Author") || null, info },
        outline: readOutline(m, doc),
        fonts,
        pages,
      },
    };
  } finally {
    m.FPDF_CloseDocument(doc);
    m.pdfium.wasmExports.free(filePtr);
  }
}

export interface Raster {
  data: Uint8Array;
  width: number;
  height: number;
  scale: number;
}

/**
 * Render one page to greyscale-ish RGBA pixels. Used only as an *alternative
 * extraction source* — for pages or spans whose fonts supply no usable Unicode
 * mapping at all, and for scanned pages.
 */
export async function renderPage(
  bytes: Uint8Array,
  wasmBinary: Uint8Array,
  pageNo: number,
  scale: number,
): Promise<Raster> {
  const m = await pdfiumModule(wasmBinary);
  const filePtr = m.pdfium.wasmExports.malloc(bytes.length);
  m.pdfium.HEAPU8.set(bytes, filePtr);
  const doc = m.FPDF_LoadMemDocument(filePtr, bytes.length, "") as number;
  if (!doc) {
    m.pdfium.wasmExports.free(filePtr);
    throw new Error("the PDF could not be opened");
  }
  try {
    const page = m.FPDF_LoadPage(doc, pageNo - 1) as number;
    const w = Math.max(1, Math.round((m.FPDF_GetPageWidthF(page) as number) * scale));
    const h = Math.max(1, Math.round((m.FPDF_GetPageHeightF(page) as number) * scale));
    const bitmap = m.FPDFBitmap_CreateEx(w, h, 4 /* BGRA */, 0, 0) as number;
    m.FPDFBitmap_FillRect(bitmap, 0, 0, w, h, 0xffffffff);
    m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, w, h, 0, 0);
    const buf = m.FPDFBitmap_GetBuffer(bitmap) as number;
    const stride = m.FPDFBitmap_GetStride(bitmap) as number;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const row = m.pdfium.HEAPU8.subarray(buf + y * stride, buf + y * stride + w * 4) as Uint8Array;
      data.set(row, y * w * 4);
    }
    m.FPDFBitmap_Destroy(bitmap);
    m.FPDF_ClosePage(page);
    return { data, width: w, height: h, scale };
  } finally {
    m.FPDF_CloseDocument(doc);
    m.pdfium.wasmExports.free(filePtr);
  }
}
