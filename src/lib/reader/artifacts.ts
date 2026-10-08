import type { Line } from "./lines";
import type { Block, DocumentModel, RawLink } from "./types";

/** Pages per persisted chunk. Keeps each artifact request small. */
export const CHUNK_PAGES = 25;

export interface PageSpans {
  page: number;
  width: number;
  height: number;
  lines: Line[];
  links: RawLink[];
  /** how this page's text was obtained */
  method?: "native" | "ocr" | "empty";
  /** mean OCR confidence, when the page was OCR'd */
  ocrConfidence?: number;
}

/** Everything but the per-page detail: loaded once when a document is opened. */
export interface ModelArtifact extends Omit<DocumentModel, "blocks"> {
  chunkCount: number;
  chunkPages: number;
  /** blockId -> page, so any reference target can be located without a scan */
  blockPage: Record<string, number>;
  /** blockId -> ordinal position in the reading order */
  blockOrder: Record<string, number>;
}

/** Per-page-range detail: line clusters (spans) plus the blocks built from them. */
export interface ChunkArtifact {
  index: number;
  from: number;
  to: number;
  pages: PageSpans[];
  blocks: Block[];
}

export function chunkOfPage(page: number, chunkPages = CHUNK_PAGES): number {
  return Math.floor((Math.max(1, page) - 1) / chunkPages);
}

export function chunkRange(index: number, pageCount: number, chunkPages = CHUNK_PAGES) {
  const from = index * chunkPages + 1;
  return { from, to: Math.min(pageCount, from + chunkPages - 1) };
}
