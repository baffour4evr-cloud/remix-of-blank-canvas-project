// OCR ingestion model. Nothing downstream of the normalization pipeline knows
// whether a word came from a PDF text layer or from OCR; this module only
// describes what the OCR path produces and persists.

/** How a page's text was obtained. */
export type ExtractionMethod = "native" | "ocr" | "empty";

/**
 * What a page *is*, decided from evidence in the file alone:
 * - `native`      a usable text layer
 * - `poor_native` a text layer exists but decodes to something unusable
 * - `scanned`     no usable text layer; the page carries a rendered image
 * - `empty`       neither text nor image (blank page, separator sheet)
 */
export type PageKind = "native" | "poor_native" | "scanned" | "empty";

/** How the document as a whole extracts. */
export type DocumentKind = "native-text" | "scanned" | "mixed" | "empty";

export interface OcrWord {
  /** word text as recognised */
  t: string;
  /** bounding box in image pixels */
  x: number;
  y: number;
  w: number;
  h: number;
  /** confidence in [0,1] */
  c: number;
  /** first word of an OCR line */
  sol?: boolean;
  /** index of the OCR text line this word belongs to */
  l: number;
  /** bottom edge and height of that whole line, in image pixels */
  ly: number;
  lh: number;
}

/** Persisted OCR result for one page. Stored once, never recomputed. */
export interface OcrPageArtifact {
  page: number;
  /** image resolution the OCR ran at */
  imgWidth: number;
  imgHeight: number;
  /** PDF user-space page box, so words can be mapped back into page geometry */
  pdfWidth: number;
  pdfHeight: number;
  words: OcrWord[];
  meanConfidence: number;
  lowConfidenceWords: number;
  ms: number;
  /** a decodable raster image was found on the page (false = nothing to OCR) */
  hasImage?: boolean;
  /** fraction of the page area the OCR'd image covers */
  imageCoverage?: number;
  error?: string;
}

/** Per-page classification evidence, decided from the file, never the filename. */
export interface PageClass {
  page: number;
  /** what the page is; `method` is what we decided to do about it */
  kind: PageKind;
  method: ExtractionMethod;
  /** characters found in the text layer */
  chars: number;
  /** how readable that text layer is, 0..1 (1 = clean prose) */
  quality?: number;
  /** the page had text, but it was unusable, so OCR recovered it */
  recovered?: boolean;
  /** number of raster images painted on the page */
  images: number;
  /** fraction of the page area covered by the largest image */
  imageCoverage: number;
  reason: string;
}

export interface ScanReport {
  kind: DocumentKind;
  pageCount: number;
  pages: PageClass[];
  /** pages that need OCR, in order */
  ocrPages: number[];
}
