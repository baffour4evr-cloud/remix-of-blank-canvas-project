/// <reference lib="webworker" />
// Browser ingest worker: classification, OCR and text-layer extraction.
//
// Every WebAssembly engine the import needs starts here, in the reader's own
// browser, where compiling WebAssembly is allowed. The hosted server forbids
// it ("Wasm code generation disallowed by embedder"), so these modules must
// never be reachable from server code — server-engines.test.ts enforces that.

import { extractDocument } from "../source/extract";
import { engineAssets } from "./assets";
import { ocrPdfPage } from "./ocr-page";
import { getEngine } from "./tesseract";
import { classifyDocument, openPdf } from "./pdfjs";
import type { ScanReport } from "../ocr/types";
import type { IngestEvent, IngestRequest } from "./protocol";

const post = (e: IngestEvent) => (self as unknown as Worker).postMessage(e);
const log = (msg: string, extra?: unknown) => console.info(`[ingest] ${msg}`, extra ?? "");

self.onmessage = async (msg: MessageEvent<IngestRequest>) => {
  const req = msg.data;
  try {
    const bytes = new Uint8Array(req.bytes);
    log("worker started", { bytes: bytes.length, hasScan: !!req.scan, skipOcr: req.skipOcr.length, needRaw: req.needRaw });
    let scan: ScanReport | null = req.scan;
    // pdf.js takes ownership of the buffer it is handed: give it a copy.
    let pdf: Awaited<ReturnType<typeof openPdf>> | null = null;
    const pdfjsDoc = async () => (pdf ??= await openPdf(new Uint8Array(bytes)));

    if (!scan) {
      const classified: ScanReport = await classifyDocument(await pdfjsDoc(), (done, total) =>
        post({ type: "progress", stage: "classify", done, total }),
      );
      post({ type: "scan", scan: classified });
      log("classified", { kind: classified.kind, pages: classified.pageCount, ocrPages: classified.ocrPages.length });
      scan = classified;
    }

    const skip = new Set(req.skipOcr);
    const pending = scan.ocrPages.filter((p) => !skip.has(p));
    if (pending.length) {
      const assets = await engineAssets.ocr();
      // Start the engine here, outside any per-page handler. If it cannot start,
      // the import stops with that error instead of recording an error per page.
      await getEngine(assets);
      log("OCR engine ready", { pending: pending.length });
      let done = scan.ocrPages.length - pending.length;
      const failed: string[] = [];
      let consecutive = 0;
      let first = true;
      for (const n of pending) {
        const art = await ocrPdfPage(await pdfjsDoc(), n, assets);
        if (first) {
          first = false;
          log("first OCR page", {
            page: n,
            words: art.words.length,
            meanConfidence: art.meanConfidence,
            imgWidth: art.imgWidth,
            imgHeight: art.imgHeight,
            hasImage: art.hasImage,
            error: art.error ?? null,
            ms: art.ms,
          });
        }
        if (art.error) {
          // A failed page is never stored as if it were finished.
          failed.push(`page ${n}: ${art.error}`);
          if (++consecutive >= 5) {
            throw new Error(`OCR is failing on consecutive pages. First failure — ${failed[0]}`);
          }
        } else {
          if (art.words.length > 0) consecutive = 0;
          post({ type: "ocr", art });
        }
        post({ type: "progress", stage: "ocr", done: ++done, total: scan.ocrPages.length });
      }
      if (failed.length) {
        throw new Error(
          `OCR failed on ${failed.length} page(s); they were not saved, so Resume will retry them. First failure — ${failed[0]}`,
        );
      }
    }

    if (req.needRaw) {
      const res = await extractDocument(new Uint8Array(bytes), {
        wasm: await engineAssets.pdfium(),
        ocr: engineAssets.ocr,
        onProgress: (done, total) => post({ type: "progress", stage: "extract", done, total }),
        ...(req.title ? { title: req.title } : {}),
      });
      post({ type: "raw", raw: res.raw, recovered: res.recovered, unresolved: res.unresolved });
    }
    post({ type: "done" });
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
