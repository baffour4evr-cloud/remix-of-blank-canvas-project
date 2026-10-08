// Messages between the library page and the browser ingest worker.
//
// The worker does every piece of work that needs a WebAssembly engine
// (PDFium, Tesseract) or pdf.js. The page persists what it reports. The server
// never opens the PDF.

import type { OcrPageArtifact, ScanReport } from "../ocr/types";
import type { RawDoc } from "../reader/types";

export interface IngestRequest {
  bytes: ArrayBuffer;
  /** classification already on disk; the worker classifies when absent */
  scan: ScanReport | null;
  /** OCR pages already on disk: never redone */
  skipOcr: number[];
  /** the text layer still has to be extracted */
  needRaw: boolean;
  title?: string;
}

export type IngestEvent =
  | { type: "progress"; stage: "classify" | "ocr" | "extract"; done: number; total: number }
  | { type: "scan"; scan: ScanReport }
  | { type: "ocr"; art: OcrPageArtifact }
  | { type: "raw"; raw: RawDoc; recovered: number; unresolved: number }
  | { type: "done" }
  | { type: "error"; message: string };

/** What the server's analysis step reads; written by the browser. */
export const RAW_ARTIFACT = "raw.json";
export const SCAN_ARTIFACT = "scan.json";
