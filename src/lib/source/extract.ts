/**
 * Extraction entry point: PDF bytes -> positioned text spans.
 *
 *   bytes
 *     -> PDFium per-character evidence   (pdfium.ts, observation only)
 *     -> reconstruction                  (reconstruct.ts, words/lines/typography)
 *     -> rendered-glyph recovery         (glyph-ocr.ts, unmapped spans only)
 *     -> RawDoc                          (consumed unchanged by every later stage)
 *
 * Runs in the browser ingest worker only. The hosted server refuses to compile
 * WebAssembly at run time, so no engine may ever start there; the server only
 * receives the finished RawDoc.
 */

import type { RawDoc } from "../reader/types";
import type { OcrAssets } from "../ingest/tesseract";
import { reconstruct } from "./reconstruct";
import { extractSourceDoc } from "./pdfium";

export interface ExtractResult {
  raw: RawDoc;
  /** spans read off the rendered glyphs because their font supplied no mapping */
  recovered: number;
  /** spans still without usable characters */
  unresolved: number;
}

export interface ExtractDocOptions {
  /** PDFium WASM bytes */
  wasm: Uint8Array;
  /** rendered-glyph recovery needs the OCR engine; skipped when absent */
  ocr?: () => Promise<OcrAssets>;
  onProgress?: (page: number, total: number) => void;
  title?: string;
}

export async function extractDocument(bytes: Uint8Array, opts: ExtractDocOptions): Promise<ExtractResult> {
  const { doc } = await extractSourceDoc(bytes, opts.wasm, {
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  const raw = reconstruct(doc, { ...(opts.title ? { title: opts.title } : {}) });

  let recovered = 0;
  if (opts.ocr) {
    try {
      const { recoverUnmappedSpans } = await import("./glyph-ocr");
      const spans = await recoverUnmappedSpans(doc, bytes, opts.wasm, await opts.ocr());
      const byPage = new Map(raw.pages.map((p) => [p.page, p]));
      for (const s of spans) {
        const item = byPage.get(s.page)?.items.find((i) => i.o === s.order);
        if (!item || !item.unmapped) continue;
        item.t = s.text;
        item.repair = "glyph-ocr";
        item.conf = s.confidence;
        item.map = {
          kind: "glyph-ocr",
          authoritative: false,
          confidence: s.confidence,
          evidence: "the font supplied no Unicode mapping; text read from the rendered glyphs",
          font: item.f,
        };
        delete item.uncertain;
        recovered++;
      }
    } catch {
      /* recovery is best-effort: unmapped spans stay unresolved */
    }
  }

  const unresolved = raw.pages.reduce((n, p) => n + p.items.filter((i) => i.unmapped && !i.repair).length, 0);
  return { raw, recovered, unresolved };
}
